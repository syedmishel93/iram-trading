/**
 * The learning store — claims, resolution, and the arithmetic on top.
 *
 * Every test here guards a place where a plausible shortcut would make the
 * terminal's track record flattering. That is the only failure mode that
 * matters in this module: a hit rate that is too high is worse than no hit
 * rate, because somebody will size from it.
 */

import { describe, expect, it } from "vitest";
import {
  buildClaim,
  claimR,
  claimR_realised,
  claimVerdict,
  HORIZON_BARS,
  MIN_HORIZON_MS,
  RECORD_COOLDOWN_MS,
  sanitiseClaim,
  shouldRecord,
  type Claim,
  type ClaimDraft,
} from "../src/learn/claim";
import { applyResolution, resolveClaim, sweep } from "../src/learn/resolve";
import { byScore, cardLine, gateVerdict, MIN_FOR_RATE, proportion, scorecard, wilson } from "../src/learn/scorecard";
import { buildRun, drift, lowerIsBetter, sanitiseRun, type ModelRun } from "../src/learn/run";
import { createLearnStore, evictClaims, evictRuns, MAX_CLAIMS } from "../src/learn/store";
import { createKV, memoryRawStore } from "../src/store/kv";
import type { BarView } from "../src/chart/series";

const NOW = 1_788_000_000_000;
const HOUR = 3_600_000;

const draft = (over: Partial<ClaimDraft> = {}): ClaimDraft => ({
  symbol: "BTCUSDT",
  timeframe: "1h",
  side: "long",
  verdict: "take",
  gatesFailed: 0,
  score: 0.6,
  coverage: 0.7,
  confidence: 0.5,
  entry: 100,
  stop: 90,
  target: 120,
  horizonMs: 24 * HOUR,
  ...over,
});

const mk = (over: Partial<ClaimDraft> = {}, at = NOW): Claim => {
  const r = buildClaim(draft(over), at);
  if (!r.ok) throw new Error(r.reason);
  return r.claim;
};

const bar = (t: number, l: number, h: number, c = (l + h) / 2): BarView => ({ t, o: c, h, l, c, v: 1 });

// ---------------------------------------------------------------------------
describe("buildClaim", () => {
  it("keeps the levels that make it falsifiable", () => {
    const c = mk();
    expect(c.entry).toBe(100);
    expect(c.stop).toBe(90);
    expect(c.target).toBe(120);
    expect(c.expiresAt).toBe(NOW + 24 * HOUR);
    expect(c.outcome).toBe("pending");
  });

  /**
   * THE ONE THAT WOULD CORRUPT EVERY STATISTIC. A long whose target sits below
   * its entry is not an unusual claim, it is a bug upstream — and recording it
   * would resolve instantly against the wrong barrier and bury that bug inside
   * a hit rate where nobody would ever find it.
   */
  it("refuses levels on the wrong side of entry", () => {
    expect(buildClaim(draft({ target: 80 }), NOW).ok).toBe(false);
    expect(buildClaim(draft({ stop: 110 }), NOW).ok).toBe(false);
    expect(buildClaim(draft({ side: "short", target: 120, stop: 90 }), NOW).ok).toBe(false);
    /* And the mirrored short, which must be accepted. */
    expect(buildClaim(draft({ side: "short", target: 80, stop: 110 }), NOW).ok).toBe(true);
  });

  it("refuses a horizon too short to be checked against a closed bar", () => {
    const r = buildClaim(draft({ horizonMs: MIN_HORIZON_MS - 1 }), NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/at least/);
  });

  it("refuses prices that are not prices", () => {
    for (const bad of [{ entry: NaN }, { stop: 0 }, { target: -5 }]) {
      expect(buildClaim(draft(bad), NOW).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  /* Null and 0.5 are different claims: one says nothing about frequency, the
     other says "a coin". Only a real probability survives. */
  it("keeps a stated probability and drops a non-probability", () => {
    expect(mk({ probability: 0.62 }).probability).toBeCloseTo(0.62, 10);
    for (const p of [0, 1, -0.2, 1.5, NaN, null, undefined]) {
      expect(mk({ probability: p as number }).probability, String(p)).toBeNull();
    }
  });

  it("matches the Python classifier's horizon so the two are comparable", () => {
    expect(HORIZON_BARS).toBe(24);
  });
});

// ---------------------------------------------------------------------------
describe("claimVerdict", () => {
  it("treats armed as a clearance, because the gates passed", () => {
    expect(claimVerdict("go")).toBe("take");
    expect(claimVerdict("armed")).toBe("take");
  });

  it("treats a conflict as a refusal", () => {
    expect(claimVerdict("stand-down")).toBe("stand-down");
    expect(claimVerdict("conflict")).toBe("stand-down");
  });

  /**
   * THE CONTAMINATION GUARD. `unknown` means the gates could not be evaluated.
   * Filing it under stand-downs would fill the "what the gates blocked"
   * population with cases where the gates never ran, and the whole value of
   * that population is that it holds genuine refusals.
   */
  it("records nothing for a verdict the gates could not reach", () => {
    expect(claimVerdict("unknown")).toBeNull();
    expect(claimVerdict("anything-else")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("shouldRecord", () => {
  it("records the first claim on an instrument", () => {
    expect(shouldRecord([], draft(), NOW)).toBe(true);
  });

  /* Without this the Setup card writes one claim per tick and the hit rate
     becomes a measurement of how long the tab was open. */
  it("suppresses a repeat of the same read inside the cooldown", () => {
    expect(shouldRecord([mk()], draft(), NOW + 60_000)).toBe(false);
    expect(shouldRecord([mk()], draft(), NOW + RECORD_COOLDOWN_MS)).toBe(true);
  });

  it("records immediately when the terminal changes its mind", () => {
    const existing = [mk()];
    expect(shouldRecord(existing, draft({ side: "short", target: 80, stop: 110 }), NOW + 1000)).toBe(true);
    expect(shouldRecord(existing, draft({ verdict: "stand-down" }), NOW + 1000)).toBe(true);
  });

  it("keeps instruments and timeframes independent", () => {
    const existing = [mk()];
    expect(shouldRecord(existing, draft({ symbol: "ETHUSDT" }), NOW + 1000)).toBe(true);
    expect(shouldRecord(existing, draft({ timeframe: "4h" }), NOW + 1000)).toBe(true);
  });

  /* The cooldown is measured from the NEWEST comparable claim, not the first
     one found. An unsorted store would otherwise let a stale entry reopen the
     window and the cooldown would do nothing. */
  it("measures the cooldown from the newest claim, whatever the list order", () => {
    const old = mk({}, NOW - 10 * HOUR);
    const recent = mk({}, NOW);
    expect(shouldRecord([recent, old], draft(), NOW + 60_000)).toBe(false);
    expect(shouldRecord([old, recent], draft(), NOW + 60_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("resolveClaim", () => {
  const c = mk();

  /**
   * THE LOOK-AHEAD GUARD. The bar a claim was made inside is still forming, and
   * scoring against it would mark the claim on the very move that produced it.
   */
  it("ignores the bar the claim was made in", () => {
    /* A bar stamped exactly at `at` that would have hit the target. */
    const r = resolveClaim(c, [bar(NOW, 95, 130)]);
    expect(r.outcome).toBe("pending");
  });

  it("marks a target reached", () => {
    const r = resolveClaim(c, [bar(NOW + HOUR, 98, 125)]);
    expect(r.outcome).toBe("target");
    expect(r.price).toBe(120);
  });

  it("marks a stop hit", () => {
    const r = resolveClaim(c, [bar(NOW + HOUR, 85, 105)]);
    expect(r.outcome).toBe("stop");
    expect(r.price).toBe(90);
  });

  /**
   * THE COIN FLIP THAT IS NOT TAKEN. One bar covering both barriers does not
   * say which came first — OHLC is four numbers, not a path. Guessing here
   * injects noise straight into the statistic the whole desk rests on.
   */
  it("refuses to judge a bar that covered both barriers", () => {
    const r = resolveClaim(c, [bar(NOW + HOUR, 85, 130)]);
    expect(r.outcome).toBe("unknowable");
  });

  it("expires only once the series has actually reached the deadline", () => {
    /* Bars that go nowhere, ending BEFORE the deadline: still pending. */
    expect(resolveClaim(c, [bar(NOW + HOUR, 99, 101)]).outcome).toBe("pending");
    /* Bars that reach past it: expired. */
    const past = [bar(NOW + HOUR, 99, 101), bar(NOW + 25 * HOUR, 99, 101)];
    expect(resolveClaim(c, past).outcome).toBe("expired");
  });

  /**
   * A gap in history, a feed that was down, a symbol not opened for a month:
   * in all three the wall clock has passed the deadline while the EVIDENCE has
   * not. Expiring on the clock would score claims against bars nobody has.
   */
  it("does not expire on the clock when the bars stop short", () => {
    const stale = [bar(NOW + HOUR, 99, 101)];
    expect(resolveClaim(c, stale).outcome).toBe("pending");
  });

  it("stops at the deadline rather than reading past it", () => {
    /* Nothing until well after expiry, then a clean target hit. That hit is
       not this claim's — it happened after the claim had already run out. */
    const bars = [bar(NOW + HOUR, 99, 101), bar(NOW + 30 * HOUR, 98, 200)];
    expect(resolveClaim(c, bars).outcome).toBe("expired");
  });

  it("mirrors correctly for a short", () => {
    const s = mk({ side: "short", target: 80, stop: 110 });
    expect(resolveClaim(s, [bar(NOW + HOUR, 75, 105)]).outcome).toBe("target");
    expect(resolveClaim(s, [bar(NOW + HOUR, 95, 115)]).outcome).toBe("stop");
  });

  it("leaves an already-settled claim alone", () => {
    const settled = applyResolution(c, { outcome: "stop", at: NOW + HOUR, price: 90 });
    /* Bars that would now say "target" must not overturn a recorded outcome. */
    expect(resolveClaim(settled, [bar(NOW + 2 * HOUR, 98, 130)]).outcome).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
describe("sweep", () => {
  it("marks only what the supplied bars can settle", () => {
    const claims = [mk(), mk({ symbol: "ETHUSDT" }, NOW + 1)];
    const r = sweep(claims, (sym) => (sym === "BTCUSDT" ? [bar(NOW + HOUR, 98, 125)] : []));
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.symbol).toBe("BTCUSDT");
    expect(r.notChecked).toBe(1);
  });

  /**
   * NO BARS IS NOT AN OUTCOME. Marking a claim against a series the terminal
   * does not have is the difference between an honest track record and a
   * pessimistic one.
   */
  it("never expires a claim whose series was not supplied", () => {
    const r = sweep([mk()], () => []);
    expect(r.resolved).toHaveLength(0);
    expect(r.notChecked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("claimR_realised", () => {
  it("pays the planned R on a target and −1 on a stop", () => {
    expect(claimR(mk())).toBeCloseTo(2, 10);
    expect(claimR_realised(applyResolution(mk(), { outcome: "target", at: NOW + 1, price: 120 }))).toBeCloseTo(2, 10);
    expect(claimR_realised(applyResolution(mk(), { outcome: "stop", at: NOW + 1, price: 90 }))).toBe(-1);
  });

  /**
   * An expiry is scored from where price actually was, not as flat. Scoring it
   * as zero flatters every claim that was quietly deep in the red when the
   * clock ran out.
   */
  it("scores an expiry from the exit price, and refuses without one", () => {
    const half = applyResolution(mk(), { outcome: "expired", at: NOW + 1, price: 95 });
    expect(claimR_realised(half)).toBeCloseTo(-0.5, 10);
    const blind = applyResolution(mk(), { outcome: "expired", at: NOW + 1, price: null });
    expect(claimR_realised(blind)).toBeNull();
  });

  it("returns null for pending and unknowable", () => {
    expect(claimR_realised(mk())).toBeNull();
    expect(claimR_realised(applyResolution(mk(), { outcome: "unknowable", at: NOW + 1, price: 100 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("wilson", () => {
  /**
   * WHY NOT THE TEXTBOOK NORMAL INTERVAL. At 0 hits it has zero width — it
   * would report "0%, and we are certain" from a single loss.
   */
  it("keeps a sane width at zero and at one", () => {
    const none = wilson(0, 5);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.3);

    const all = wilson(5, 5);
    expect(all.high).toBe(1);
    expect(all.low).toBeLessThan(0.7);
  });

  it("stays inside [0,1] and narrows as the sample grows", () => {
    const small = wilson(3, 4);
    const large = wilson(300, 400);
    expect(small.low).toBeGreaterThanOrEqual(0);
    expect(small.high).toBeLessThanOrEqual(1);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  /* The example from the module header, which is the reason it exists. */
  it("shows that 3 of 4 is consistent with a losing system", () => {
    const w = wilson(3, 4);
    expect(w.low).toBeLessThan(0.4);
    expect(w.high).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
describe("proportion", () => {
  it("refuses a percentage below the sample floor and says how far off it is", () => {
    const p = proportion(3, 4, "hit rate");
    expect(p.reportable).toBe(false);
    expect(p.text).toContain("3 of 4");
    expect(p.text).not.toContain("75%");
    expect(p.text).toContain(`${MIN_FOR_RATE - 4} more`);
  });

  it("reports the rate with its range once the sample clears the floor", () => {
    const p = proportion(15, 30, "hit rate");
    expect(p.reportable).toBe(true);
    expect(p.text).toContain("50%");
    expect(p.text).toContain("between");
  });

  it("says nothing at all when nothing has resolved", () => {
    expect(proportion(0, 0, "hit rate").text).toMatch(/Nothing resolved yet/);
  });
});

// ---------------------------------------------------------------------------
describe("gateVerdict", () => {
  const settled = (verdict: "take" | "stand-down", outcome: "target" | "stop", i: number): Claim =>
    applyResolution(mk({ verdict }, NOW + i), { outcome, at: NOW + i + HOUR, price: outcome === "target" ? 120 : 90 });

  const pool = (takeWins: number, takeN: number, downWins: number, downN: number): Claim[] => {
    const out: Claim[] = [];
    let i = 0;
    for (let k = 0; k < takeN; k++) out.push(settled("take", k < takeWins ? "target" : "stop", i++));
    for (let k = 0; k < downN; k++) out.push(settled("stand-down", k < downWins ? "target" : "stop", i++));
    return out;
  };

  it("refuses the comparison until both sides clear the floor", () => {
    const g = gateVerdict(pool(8, 10, 2, 10));
    expect(g.separated).toBe(false);
    expect(g.text).toMatch(/Not enough yet/);
  });

  /**
   * THE FINDING THAT MUST BE ALLOWED TO HAPPEN. Overlapping intervals mean the
   * gates are not measurably picking better than they are refusing, and the
   * desk says so rather than reporting the point estimates as a difference.
   */
  it("reports overlap as a real finding, not a missing one", () => {
    const g = gateVerdict(pool(15, 30, 14, 30));
    expect(g.separated).toBe(false);
    expect(g.text).toMatch(/overlap/);
    expect(g.text).toMatch(/real finding/);
  });

  it("reports a genuine separation when the intervals clear each other", () => {
    const g = gateVerdict(pool(95, 100, 10, 100));
    expect(g.separated).toBe(true);
    expect(g.liftPoints).toBeGreaterThan(0);
    expect(g.text).toMatch(/separating/);
  });

  /** The gates filtering backwards is a finding the desk must be able to print. */
  it("says so when the blocked setups did better", () => {
    const g = gateVerdict(pool(10, 100, 95, 100));
    expect(g.separated).toBe(true);
    expect(g.liftPoints).toBeLessThan(0);
    expect(g.text).toMatch(/wrong way round/);
  });
});

// ---------------------------------------------------------------------------
describe("byScore", () => {
  it("bands on absolute score, so a short is not a separate population", () => {
    const long = applyResolution(mk({ score: 0.9 }, NOW), { outcome: "target", at: NOW + 1, price: 120 });
    const short = applyResolution(mk({ score: -0.9, side: "short", target: 80, stop: 110 }, NOW + 1), {
      outcome: "target",
      at: NOW + 2,
      price: 80,
    });
    const bands = byScore([long, short]);
    const top = bands[bands.length - 1];
    expect(top?.hit.n).toBe(2);
  });

  /* A score landing exactly on a band edge must fall in one band, not two. */
  it("puts an edge score in exactly one band", () => {
    const c = applyResolution(mk({ score: 0.4 }), { outcome: "target", at: NOW + 1, price: 120 });
    const bands = byScore([c], 5);
    expect(bands.reduce((n, b) => n + b.hit.n, 0)).toBe(1);
    expect(bands[2]?.hit.n).toBe(1);
  });

  it("puts a perfect score in the top band rather than nowhere", () => {
    const c = applyResolution(mk({ score: 1 }), { outcome: "target", at: NOW + 1, price: 120 });
    const bands = byScore([c], 5);
    expect(bands[4]?.hit.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("scorecard", () => {
  it("says plainly that nothing is recorded yet", () => {
    expect(scorecard([]).headline).toMatch(/Nothing recorded yet/);
  });

  it("distinguishes recorded-but-unresolved from resolved", () => {
    expect(scorecard([mk()]).headline).toMatch(/none resolved yet/);
  });

  it("keeps expectancy beside the hit rate once both exist", () => {
    const claims = Array.from({ length: 40 }, (_, i) =>
      applyResolution(mk({}, NOW + i), {
        outcome: i % 2 === 0 ? "target" : "stop",
        at: NOW + i + HOUR,
        price: i % 2 === 0 ? 120 : 90,
      }),
    );
    const c = scorecard(claims);
    expect(c.all.hit.reportable).toBe(true);
    /* Half at +2R, half at −1R: +0.50R. A 50% hit rate that makes money, which
       is exactly why the two numbers travel together. */
    expect(c.all.expectancyR).toBeCloseTo(0.5, 10);
    expect(c.headline).toContain("+0.50R");
  });
});

// ---------------------------------------------------------------------------
describe("model runs", () => {
  const run = (over: Partial<ModelRun> = {}, at = NOW): ModelRun => ({
    ...buildRun(
      { kind: "classify", symbol: "BTCUSDT", timeframe: "1h", bars: 800, metric: 0.58, metricName: "AUC", beatsChance: true, verdict: "ok" },
      at,
    ),
    ...over,
  });

  it("keeps null and false apart on beatsChance", () => {
    const asked = buildRun({ kind: "classify", symbol: "X", timeframe: "1h", bars: 1, metricName: "AUC", beatsChance: false, verdict: "" }, NOW);
    const unasked = buildRun({ kind: "volatility", symbol: "X", timeframe: "1h", bars: 1, metricName: "half-life", verdict: "" }, NOW);
    expect(asked.beatsChance).toBe(false);
    expect(unasked.beatsChance).toBeNull();
  });

  it("needs two runs of the same question before it claims a trend", () => {
    expect(drift([run()])).toHaveLength(0);
    expect(drift([run({}, NOW), run({}, NOW + HOUR)])).toHaveLength(1);
  });

  /* Two different questions are not a trend in one. */
  it("never compares across instruments or timeframes", () => {
    const d = drift([run({ symbol: "BTCUSDT" }, NOW), run({ symbol: "ETHUSDT" }, NOW + HOUR)]);
    expect(d).toHaveLength(0);
  });

  it("names a falling AUC as a deterioration", () => {
    const d = drift([run({ metric: 0.6 }, NOW), run({ metric: 0.51 }, NOW + HOUR)]);
    expect(d[0]?.change).toBeCloseTo(-0.09, 10);
    expect(d[0]?.better).toBe(false);
    expect(d[0]?.text).toMatch(/fitting less well/);
  });

  /**
   * THE ONE THAT WOULD HAVE BEEN BACKWARDS. QLIKE is a LOSS — the volatility
   * model that scores lower is the better one. Reading every fall as a decay
   * would report an improving model as a decaying one, confidently, with a red
   * number beside it.
   */
  it("reads a falling QLIKE as an improvement, not a decay", () => {
    const d = drift([
      run({ metric: 0.42, metricName: "QLIKE", kind: "volatility" }, NOW),
      run({ metric: 0.31, metricName: "QLIKE", kind: "volatility" }, NOW + HOUR),
    ]);
    expect(d[0]?.change).toBeLessThan(0);
    expect(d[0]?.better).toBe(true);
    expect(d[0]?.text).toMatch(/improvement/);
  });

  it("calls a change too small to read neither better nor worse", () => {
    const d = drift([run({ metric: 0.58 }, NOW), run({ metric: 0.583 }, NOW + HOUR)]);
    expect(d[0]?.better).toBeNull();
    expect(d[0]?.text).toMatch(/not moved/);
  });

  it("knows which metrics are losses", () => {
    expect(lowerIsBetter("QLIKE")).toBe(true);
    expect(lowerIsBetter("Brier")).toBe(true);
    expect(lowerIsBetter("AUC")).toBe(false);
  });

  it("survives a round trip through storage", () => {
    const r = run();
    expect(sanitiseRun(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it("rejects a record with no id", () => {
    expect(sanitiseRun({ at: NOW, kind: "classify", symbol: "X" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("sanitiseClaim", () => {
  it("survives a round trip", () => {
    const c = mk();
    expect(sanitiseClaim(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("rejects an unknown outcome rather than defaulting it", () => {
    const c = { ...mk(), outcome: "probably-fine" };
    expect(sanitiseClaim(c)).toBeNull();
  });

  it("rejects a record missing the levels that make it checkable", () => {
    const { stop: _stop, ...noStop } = mk();
    expect(sanitiseClaim(noStop)).toBeNull();
  });

  it("normalises the symbol so the same instrument is one population", () => {
    expect(sanitiseClaim({ ...mk(), symbol: "btcusdt" })?.symbol).toBe("BTCUSDT");
  });
});

// ---------------------------------------------------------------------------
describe("eviction", () => {
  /**
   * THE BIAS THIS PREVENTS. Claims resolve on a delay, so the newest are always
   * the unresolved ones. Evicting by age alone would drop claims that were
   * still waiting to be marked — and losing exactly the ones that might have
   * counted against the terminal is the one bias this store must not have.
   */
  it("never evicts a pending claim", () => {
    const pending = Array.from({ length: MAX_CLAIMS + 50 }, (_, i) => mk({}, NOW + i));
    const kept = evictClaims(pending);
    expect(kept).toHaveLength(MAX_CLAIMS + 50);
  });

  it("drops the oldest settled claims to make room", () => {
    const settled = Array.from({ length: MAX_CLAIMS + 10 }, (_, i) =>
      applyResolution(mk({}, NOW + i), { outcome: "stop", at: NOW + i + 1, price: 90 }),
    );
    const kept = evictClaims(settled);
    expect(kept).toHaveLength(MAX_CLAIMS);
    expect(kept[0]?.at).toBe(NOW + 10);
  });

  it("never evicts a pinned run", () => {
    const runs: ModelRun[] = Array.from({ length: 500 }, (_, i) => ({
      ...buildRun({ kind: "classify", symbol: "X", timeframe: "1h", bars: 1, metricName: "AUC", verdict: "" }, NOW + i),
      pinned: i === 0,
    }));
    const kept = evictRuns(runs);
    expect(kept.some((r) => r.pinned)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("createLearnStore", () => {
  const store = () => createLearnStore(createKV(memoryRawStore()), () => NOW);

  it("records a claim and reads it back", () => {
    const s = store();
    const r = s.record(draft());
    expect(r.ok).toBe(true);
    expect(s.claims()).toHaveLength(1);
  });

  it("explains why it declined instead of failing silently", () => {
    const s = store();
    s.record(draft());
    const again = s.record(draft());
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toMatch(/half hour/);
  });

  it("records nothing while recording is off, and keeps what it has", () => {
    const s = store();
    s.record(draft());
    s.setEnabled(false);
    const r = s.record(draft({ symbol: "ETHUSDT" }));
    expect(r.ok).toBe(false);
    expect(s.claims()).toHaveLength(1);
  });

  /* The switch has to survive a reload, or it is not a setting. */
  it("persists the recording switch across a new store on the same storage", () => {
    const kv = createKV(memoryRawStore());
    const a = createLearnStore(kv, () => NOW);
    a.setEnabled(false);
    const b = createLearnStore(kv, () => NOW);
    expect(b.enabled()).toBe(false);
  });

  it("forgets one instrument without touching the others", () => {
    const s = store();
    s.record(draft());
    s.record(draft({ symbol: "ETHUSDT" }));
    expect(s.forgetSymbol("BTCUSDT")).toBe(1);
    expect(s.claims()).toHaveLength(1);
    expect(s.claims()[0]?.symbol).toBe("ETHUSDT");
  });

  it("keeps pinned runs through forget-everything", () => {
    const s = store();
    const kept = s.addRun({ kind: "classify", symbol: "X", timeframe: "1h", bars: 1, metricName: "AUC", verdict: "" });
    s.addRun({ kind: "classify", symbol: "Y", timeframe: "1h", bars: 1, metricName: "AUC", verdict: "" });
    s.pinRun(kept.id, true);
    const gone = s.forgetAll();
    expect(gone.runs).toBe(1);
    expect(s.runs()).toHaveLength(1);
    expect(s.runs()[0]?.id).toBe(kept.id);
  });

  it("merges an export without duplicating what is already held", () => {
    const s = store();
    s.record(draft());
    const snap = s.snapshot();
    expect(s.merge({ claims: [...snap.claims] })).toEqual({ claims: 0, runs: 0 });
    expect(s.claims()).toHaveLength(1);
  });

  it("resolves pending claims from bars and persists the outcome", () => {
    const kv = createKV(memoryRawStore());
    const s = createLearnStore(kv, () => NOW);
    s.record(draft());
    s.resolvePending(() => [bar(NOW + HOUR, 98, 125)]);
    expect(s.claims()[0]?.outcome).toBe("target");
    /* A second store on the same storage must see the settled outcome. */
    expect(createLearnStore(kv, () => NOW).claims()[0]?.outcome).toBe("target");
  });
});

// ---------------------------------------------------------------------------
describe("cardLine", () => {
  const settled = (over: Partial<ClaimDraft>, outcome: "target" | "stop", i: number): Claim =>
    applyResolution(mk(over, NOW + i), { outcome, at: NOW + i + HOUR, price: outcome === "target" ? 120 : 90 });

  const many = (n: number, sym: string, wins: number): Claim[] =>
    Array.from({ length: n }, (_, i) => settled({ symbol: sym }, i < wins ? "target" : "stop", i));

  /* A row that says "not enough data" on every render trains people to skip
     the block it lives in — which on this card contains the PBO line. */
  it("says nothing at all when nothing has been recorded", () => {
    expect(cardLine([], "BTCUSDT")).toBeNull();
  });

  it("counts, rather than guessing, while the sample is short", () => {
    const line = cardLine(many(4, "BTCUSDT", 3), "BTCUSDT");
    expect(line).toMatch(/It is counting/);
    expect(line).not.toMatch(/75%/);
    /* The countdown must MOVE. An earlier version printed the floor itself, so
       four settled reads still read "20 short" — a counter stuck at its start
       looks like a counter, which is worse than not having one. */
    expect(line).toContain("4 reads settled");
    expect(line).toContain(`${MIN_FOR_RATE - 4} short`);
  });

  it("says read, not reads, for exactly one", () => {
    const line = cardLine(many(1, "BTCUSDT", 1), "BTCUSDT");
    expect(line).toContain("1 read settled");
    expect(line).toContain(`${MIN_FOR_RATE - 1} short`);
  });

  it("uses the instrument's own record once it has one", () => {
    const line = cardLine(many(30, "BTCUSDT", 15), "BTCUSDT");
    expect(line).toMatch(/^On BTCUSDT/);
    expect(line).toMatch(/50%/);
  });

  /**
   * THE SCOPE LABEL. Falling back to every instrument is right — per-symbol
   * samples almost never reach the floor — but widening the scope silently
   * would let a number about Bitcoin be read as a number about gold.
   */
  it("names the wider scope when it falls back to it", () => {
    const line = cardLine(many(30, "BTCUSDT", 15), "XAUUSD");
    expect(line).toMatch(/^Across every instrument/);
  });

  it("carries the R beside the hit rate, never instead of it", () => {
    const line = cardLine(many(30, "BTCUSDT", 15), "BTCUSDT");
    /* Half at +2R, half at −1R. */
    expect(line).toMatch(/\+0\.50R per read/);
  });

  /* A gate comparison that only overlaps is a finding the DESK explains. On a
     card, with no room to explain what overlap means, it would read as a
     warning — so it is appended only when the intervals separate. */
  it("appends the gate finding only when it separates", () => {
    const mixed = [
      ...Array.from({ length: 30 }, (_, i) => settled({ verdict: "take" }, i < 15 ? "target" : "stop", i)),
      ...Array.from({ length: 30 }, (_, i) => settled({ verdict: "stand-down" }, i < 14 ? "target" : "stop", 100 + i)),
    ];
    expect(cardLine(mixed, "BTCUSDT")).not.toMatch(/measurably/);

    const clear = [
      ...Array.from({ length: 40 }, (_, i) => settled({ verdict: "take" }, i < 38 ? "target" : "stop", i)),
      ...Array.from({ length: 40 }, (_, i) => settled({ verdict: "stand-down" }, i < 4 ? "target" : "stop", 100 + i)),
    ];
    expect(cardLine(clear, "BTCUSDT")).toMatch(/cleared have done measurably better/);
  });

  /** The card must be able to report against itself. */
  it("says so when the setups it blocked did better", () => {
    const backwards = [
      ...Array.from({ length: 40 }, (_, i) => settled({ verdict: "take" }, i < 4 ? "target" : "stop", i)),
      ...Array.from({ length: 40 }, (_, i) => settled({ verdict: "stand-down" }, i < 38 ? "target" : "stop", 100 + i)),
    ];
    expect(cardLine(backwards, "BTCUSDT")).toMatch(/BLOCKED have done measurably better/);
  });
});
