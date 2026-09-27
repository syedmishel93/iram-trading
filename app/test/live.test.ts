/**
 * The live analysis engine.
 *
 * Every test here drives the PURE evaluator with an injected clock — no timers,
 * no DOM, no `Date.now()` — which is the whole reason the engine was written as
 * `(previousState, snapshot) -> {state, events}` in the first place. A day of
 * bar closes runs in microseconds.
 *
 * The shape of most of these is the same, and it is the shape the design
 * promises: make a condition true, assert ONE event, hold the condition, assert
 * NOTHING. A live engine that repeats itself is a live engine people turn off.
 */

import { describe, it, expect } from "vitest";
import {
  APPROACH_R,
  DEFAULT_CONFIG,
  OUTLIER_SIGMA,
  QUIET_PCTILE,
  STRUCTURE_MIN_CONFIDENCE,
  VOLUME_SPIKE_X,
  VOLUME_WINDOW,
  clearSeen,
  createLiveEngine,
  emptyState,
  evaluate,
  type LiveEvent,
  type LiveSetup,
  type LiveSnapshot,
  type LiveState,
} from "../src/analysis/live";
import { VOLATILE_PCTILE } from "../src/backtest/regime";
import type { BarView } from "../src/chart/series";
import type { Detection } from "../src/detect/types";
import type { FeedState, FeedQuality } from "../src/data/feed";
import type { TradePlan } from "../src/setup/plan";
import type { Verdict, VerdictKind } from "../src/setup/gates";

const INTERVAL = 60_000;
/** 2026-09-19 14:00:00 UTC. Fixed, so nothing here depends on today. */
const T0 = Date.UTC(2026, 8, 19, 14, 0, 0);

/* ───────────────────────────────────────────────────────────────── fixtures */

/**
 * Bars from a list of closes.
 *
 * The high and low are pushed out by `range` so ATR is measurable; the open is
 * the previous close so there are no gaps to make the true range jump on its
 * own.
 */
function barsFrom(closes: readonly number[], range = 0.2, volume = 1000): BarView[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] as number);
    return {
      t: T0 + i * INTERVAL,
      o,
      h: Math.max(o, c) + range / 2,
      l: Math.min(o, c) - range / 2,
      c,
      v: volume,
    };
  });
}

/** A gently alternating series: finite, non-zero EWMA sigma, nothing dramatic. */
function calmCloses(n: number, base = 100, step = 0.1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + (i % 2 === 0 ? 0 : step));
  return out;
}

const feedAt = (quality: FeedQuality, over: Partial<FeedState> = {}): FeedState => ({
  quality,
  tickAgeMs: 1_000,
  vendorLagMs: 0,
  source: "binance",
  note: "",
  ...over,
});

const verdictAt = (kind: VerdictKind, over: Partial<Verdict> = {}): Verdict => ({
  kind,
  headline: "",
  readLine: "",
  blocking: kind === "stand-down" ? [{ id: "spread", status: "block", text: "Spread is 41% of the stop distance, over your 25% ceiling." }] : [],
  unknown: [],
  passed: kind === "stand-down" ? 6 : 7,
  total: 7,
  watchLevel: null,
  conflictNote: null,
  strategy: "choch",
  ...over,
});

const planAt = (over: Partial<TradePlan> = {}): TradePlan => ({
  direction: "long",
  entryLow: 99,
  entryHigh: 101,
  entry: 100,
  stop: 97,
  target1: 106,
  target2: 112,
  r: 3,
  stopAtrMultiple: 1.2,
  stopFrom: "structure",
  structureOutOfReach: null,
  drawnAt: 100,
  ...over,
});

interface SnapOver {
  readonly now?: number;
  readonly symbol?: string;
  readonly timeframe?: string;
  readonly bars?: readonly BarView[];
  readonly detections?: readonly Detection[];
  readonly setup?: LiveSetup | null;
  readonly feed?: FeedState;
  readonly market?: LiveSnapshot["market"];
  readonly closedLen?: number;
}

/**
 * A snapshot whose bars are all CLOSED by default.
 *
 * `closedLen` defaults to every bar, which is what the tests want: each fixture
 * is a series of finished candles and "the newest one just closed" is the thing
 * being driven. The shell passes its own `closedBarCount` — see the field's
 * note in live.ts for why the caller owns that number rather than the engine.
 */
function snap(over: SnapOver = {}): LiveSnapshot {
  const bars = over.bars ?? barsFrom(calmCloses(40));
  const last = bars[bars.length - 1];
  return {
    now: over.now ?? (last === undefined ? T0 : last.t + INTERVAL),
    symbol: over.symbol ?? "BTCUSDT",
    timeframe: over.timeframe ?? "1m",
    intervalMs: INTERVAL,
    bars,
    closedLen: over.closedLen ?? bars.length,
    detections: over.detections ?? [],
    setup: over.setup === undefined ? null : over.setup,
    feed: over.feed ?? feedAt("live"),
    market: over.market ?? "open",
  };
}

/** Prime the engine on `first`, returning the state that fires from then on. */
function primed(first: LiveSnapshot = snap()): LiveState {
  const r = evaluate(emptyState(), first);
  expect(r.events).toEqual([]);
  return r.state;
}

const kinds = (events: readonly LiveEvent[]): string[] => events.map((e) => e.kind);

/* ──────────────────────────────────────────────────────────────── the rules */

describe("priming", () => {
  /**
   * THE RULE THIS PROTECTS. Loading a chart makes a dozen conditions true at
   * once — the venue is open, the feed is live, the gates block — and not one
   * of them just happened. `scan/watch.ts` makes the same promise for the same
   * reason: the first scan never notifies.
   */
  it("fires nothing on the first snapshot, however much is true", () => {
    const r = evaluate(
      emptyState(),
      snap({
        setup: { verdict: verdictAt("stand-down"), plan: planAt(), direction: "long" },
        feed: feedAt("stale", { tickAgeMs: 400_000 }),
        market: "open",
      }),
    );
    expect(r.events).toEqual([]);
    expect(r.state.primed).toBe(true);
    expect(r.state.seen).toEqual([]);
  });

  /**
   * THE SECOND PRIMING PROBLEM, MEASURED ON A REAL LOAD.
   *
   * `setupView` refuses to render until the loaded symbol, the loaded
   * timeframe, the series in hand and the derived studies have all caught up —
   * so the first second of every chart has bars and a NULL setup. When the
   * setup lands, the gates, the plan and the setup itself all become true in
   * one step. On a cold load of BTCUSDT 1h that was five events in two
   * seconds, none of them the market doing anything.
   */
  it("says nothing the first time a setup arrives, because that is the card loading", () => {
    /* Primed with bars and no setup — exactly what the shell has for the first
       beat of every chart. */
    let st = primed(snap({ setup: null }));
    const arrives = evaluate(
      st,
      snap({
        setup: { verdict: verdictAt("go"), plan: planAt(), direction: "long" },
        bars: barsFrom([...calmCloses(39), 100]),
        now: T0 + 60 * INTERVAL,
      }),
    );
    expect(arrives.events).toEqual([]);
    st = arrives.state;
    expect(st.sawSetup).toBe(true);

    /* From here on it is a live surface again: the gates really did flip. */
    const flip = evaluate(
      st,
      snap({
        setup: { verdict: verdictAt("stand-down"), plan: null, direction: "long" },
        now: T0 + 61 * INTERVAL,
      }),
    );
    expect(kinds(flip.events)).toContain("gates-blocked");
  });

  it("latches what it saw, so the second look does not report it either", () => {
    const s = snap({ setup: { verdict: verdictAt("go"), plan: planAt(), direction: "long" } });
    const first = evaluate(emptyState(), s);
    const second = evaluate(first.state, { ...s, now: s.now + 1_000 });
    expect(second.events).toEqual([]);
  });
});

describe("gates", () => {
  const blocked = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
  const clear = { verdict: verdictAt("go"), plan: planAt(), direction: "long" as const };

  it("reports the gates clearing once, and not again while they stay clear", () => {
    let st = primed(snap({ setup: blocked }));
    const a = evaluate(st, snap({ setup: clear, now: T0 + 10 * INTERVAL }));
    expect(kinds(a.events)).toContain("gates-cleared");
    st = a.state;
    const b = evaluate(st, snap({ setup: clear, now: T0 + 11 * INTERVAL }));
    expect(kinds(b.events)).not.toContain("gates-cleared");
  });

  it("carries the blocking gate's own sentence as the reason", () => {
    const st = primed(snap({ setup: clear }));
    const r = evaluate(st, snap({ setup: blocked, now: T0 + 10 * INTERVAL }));
    const e = r.events.find((x) => x.kind === "gates-blocked");
    expect(e?.severity).toBe("watch");
    /* The gate's text, verbatim — one account of one check. */
    expect(e?.because).toBe("Spread is 41% of the stop distance, over your 25% ceiling.");
    expect(e?.values).toContainEqual({ label: "Blocking", value: 1, unit: "count" });
  });

  /**
   * A gate that could not be checked has not been passed and has not been
   * failed. Publishing `unknown` as either would be the engine inventing the
   * answer the card refuses to give.
   */
  it("says nothing at all when the verdict is unknown", () => {
    const st = primed(snap({ setup: clear }));
    const r = evaluate(st, snap({ setup: { ...blocked, verdict: verdictAt("unknown") }, now: T0 + 10 * INTERVAL }));
    expect(kinds(r.events)).not.toContain("gates-blocked");
    expect(kinds(r.events)).not.toContain("gates-cleared");
  });
});

describe("the plan", () => {
  const withPlan = (plan: TradePlan): LiveSetup => ({ verdict: verdictAt("armed"), plan, direction: "long" });
  /** Bars whose last close is `price`, so the engine's "last print" is known. */
  const at = (price: number): BarView[] => barsFrom([...calmCloses(39), price]);

  it("reports price entering the entry zone once", () => {
    const plan = planAt();
    let st = primed(snap({ bars: at(105), setup: withPlan(plan) }));
    const a = evaluate(st, snap({ bars: at(100), setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(a.events)).toContain("entry-zone");
    const e = a.events.find((x) => x.kind === "entry-zone");
    expect(e?.severity).toBe("act");
    expect(e?.values).toContainEqual({ label: "Zone low", value: 99, unit: "price" });
    st = a.state;
    const b = evaluate(st, snap({ bars: at(100.5), setup: withPlan(plan), now: T0 + 61 * INTERVAL }));
    expect(kinds(b.events)).not.toContain("entry-zone");
  });

  /**
   * PRICE CANNOT ENTER A ZONE THAT WAS NOT THERE A MOMENT AGO.
   *
   * `buildPlan` draws the entry zone AROUND the current price, so the instant
   * a plan appears price is inside it. MEASURED on a cold load of BTCUSDT 1h:
   * "Price has entered the plan's entry zone", two seconds after opening the
   * page, about a zone that had existed for one frame. The same holds on every
   * redraw — `stablePlan` redraws around the new price.
   */
  it("says nothing about a plan drawn around where price already is", () => {
    const plan = planAt();
    const inZone = barsFrom([...calmCloses(39), 100]);
    /* A setup with no plan, then the plan appears with price inside it. */
    const st = primed(snap({ bars: inZone, setup: { verdict: verdictAt("armed"), plan: null, direction: "long" } }));
    const drawn = evaluate(st, snap({ bars: inZone, setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(drawn.events)).not.toContain("entry-zone");
    expect(drawn.state.planKey).not.toBeNull();

    /* Redrawn somewhere else, still around price: still not an entry. */
    const moved = planAt({ entryLow: 89, entryHigh: 91, entry: 90, stop: 87, target1: 96 });
    const away = barsFrom([...calmCloses(39), 90]);
    const redrawn = evaluate(drawn.state, snap({ bars: away, setup: withPlan(moved), now: T0 + 61 * INTERVAL }));
    expect(kinds(redrawn.events)).not.toContain("entry-zone");
  });

  /**
   * The threshold is a quarter of R, and R here is 3 — so the stop at 97 is
   * approached at 97.75 and not at 97.76. Asserted on both sides of the line,
   * because a threshold only means something if crossing it changes the answer.
   */
  it("respects the quarter-R approach threshold on both sides of it", () => {
    const plan = planAt();
    const boundary = plan.stop + APPROACH_R * plan.r;
    const outside = primed(snap({ bars: at(105), setup: withPlan(plan) }));

    const just = evaluate(outside, snap({ bars: at(boundary + 0.01), setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(just.events)).not.toContain("stop-approach");

    const over = evaluate(outside, snap({ bars: at(boundary), setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(over.events)).toContain("stop-approach");
    const e = over.events.find((x) => x.kind === "stop-approach");
    expect(e?.severity).toBe("act");
    expect(e?.values).toContainEqual({ label: "Threshold", value: APPROACH_R, unit: "r" });
    expect(e?.values).toContainEqual({ label: "Distance", value: APPROACH_R, unit: "r" });
  });

  /**
   * THE BUG THIS TEST EXISTS FOR. Measuring `|price - stop|` turns the
   * condition OFF again as price runs away through the stop, so the engine
   * would announce the approach a second time on the way back — after the
   * trade was already dead.
   */
  it("stays latched when price runs straight through the stop", () => {
    const plan = planAt();
    let st = primed(snap({ bars: at(105), setup: withPlan(plan) }));
    st = evaluate(st, snap({ bars: at(97.5), setup: withPlan(plan), now: T0 + 60 * INTERVAL })).state;
    const through = evaluate(st, snap({ bars: at(90), setup: withPlan(plan), now: T0 + 61 * INTERVAL }));
    expect(kinds(through.events)).not.toContain("stop-approach");
  });

  it("mirrors the stop and target sides for a short", () => {
    const plan = planAt({ direction: "short", entryLow: 99, entryHigh: 101, entry: 100, stop: 103, target1: 94, target2: 88 });
    const st = primed(snap({ bars: at(100), setup: withPlan(plan) }));
    const up = evaluate(st, snap({ bars: at(102.5), setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(up.events)).toContain("stop-approach");
    const down = evaluate(st, snap({ bars: at(94.5), setup: withPlan(plan), now: T0 + 60 * INTERVAL }));
    expect(kinds(down.events)).toContain("target-approach");
    expect(down.events.find((x) => x.kind === "target-approach")?.severity).toBe("watch");
  });

  it("says nothing about a plan that does not exist", () => {
    const st = primed(snap({ bars: at(105), setup: { verdict: verdictAt("stand-down"), plan: null, direction: "long" } }));
    const r = evaluate(st, snap({ bars: at(97), setup: { verdict: verdictAt("stand-down"), plan: null, direction: "long" }, now: T0 + 60 * INTERVAL }));
    expect(kinds(r.events)).not.toContain("stop-approach");
    expect(kinds(r.events)).not.toContain("entry-zone");
  });
});

describe("the feed", () => {
  it("reports degradation once per level, and treats a worse level as new", () => {
    let st = primed(snap());
    const delayed = evaluate(st, snap({ feed: feedAt("delayed", { vendorLagMs: 200_000 }), now: T0 + 60 * INTERVAL }));
    expect(kinds(delayed.events)).toContain("feed-degraded");
    expect(delayed.events.find((x) => x.kind === "feed-degraded")?.severity).toBe("watch");
    st = delayed.state;

    const again = evaluate(st, snap({ feed: feedAt("delayed", { vendorLagMs: 260_000 }), now: T0 + 61 * INTERVAL }));
    expect(kinds(again.events)).not.toContain("feed-degraded");

    const stale = evaluate(again.state, snap({ feed: feedAt("stale", { tickAgeMs: 400_000 }), now: T0 + 62 * INTERVAL }));
    expect(kinds(stale.events)).toContain("feed-degraded");
    expect(stale.events.find((x) => x.kind === "feed-degraded")?.severity).toBe("act");
    /* The threshold is the feed monitor's own, imported rather than retyped. */
    expect(stale.events.find((x) => x.kind === "feed-degraded")?.because).toContain("3-bar staleness rule");
  });

  /**
   * A SHUT VENUE IS NOT A BROKEN FEED. Reporting it as one every weekend is
   * how a real staleness alarm stops being read on a Wednesday — the same
   * argument `classify` makes in data/feed.ts and `--feed-closed` makes in
   * tokens.css.
   */
  it("never calls a closed venue a degraded feed", () => {
    const st = primed(snap());
    const r = evaluate(st, snap({ feed: feedAt("closed", { tickAgeMs: 900_000 }), now: T0 + 60 * INTERVAL }));
    expect(kinds(r.events)).not.toContain("feed-degraded");
  });

  it("reports a recovery only when something degraded first", () => {
    /* A cold load goes offline -> live. Nothing recovered; nothing broke. */
    const cold = primed(snap({ feed: feedAt("offline", { tickAgeMs: Infinity }) }));
    const warm = evaluate(cold, snap({ feed: feedAt("live"), now: T0 + 60 * INTERVAL }));
    expect(kinds(warm.events)).not.toContain("feed-recovered");

    /* A real outage does. */
    let st = primed(snap());
    st = evaluate(st, snap({ feed: feedAt("stale", { tickAgeMs: 400_000 }), now: T0 + 60 * INTERVAL })).state;
    const back = evaluate(st, snap({ feed: feedAt("live"), now: T0 + 90 * INTERVAL }));
    expect(kinds(back.events)).toContain("feed-recovered");
    expect(back.events.find((x) => x.kind === "feed-recovered")?.severity).toBe("info");
  });
});

describe("the venue", () => {
  it("reports a close and a re-open once each", () => {
    let st = primed(snap({ market: "open" }));
    const shut = evaluate(st, snap({ market: "closed", now: T0 + 60 * INTERVAL }));
    expect(kinds(shut.events)).toEqual(["session-close"]);
    st = shut.state;
    expect(kinds(evaluate(st, snap({ market: "closed", now: T0 + 61 * INTERVAL })).events)).toEqual([]);
    const open = evaluate(st, snap({ market: "open", now: T0 + 200 * INTERVAL }));
    expect(kinds(open.events)).toEqual(["session-open"]);
  });

  /* An instrument whose class the terminal does not recognise has no session.
     Guessing one would be the no-fabrication rule broken for a row. */
  it("claims nothing for an instrument with no known session", () => {
    const st = primed(snap({ market: "open" }));
    const r = evaluate(st, snap({ market: "unknown", now: T0 + 60 * INTERVAL }));
    expect(r.events).toEqual([]);
  });
});

describe("the setup engine's answer", () => {
  const view = (strategy: string | null, direction: "long" | "short" | null): LiveSetup => ({
    verdict: verdictAt("armed", { strategy }),
    plan: null,
    direction,
  });

  it("reports a setup appearing, flipping and expiring, once each", () => {
    let st = primed(snap({ setup: view(null, null) }));

    const appeared = evaluate(st, snap({ setup: view("choch", "long"), now: T0 + 60 * INTERVAL }));
    expect(kinds(appeared.events)).toContain("setup-appeared");
    expect(appeared.events.find((x) => x.kind === "setup-appeared")?.what).toContain("choch");
    st = appeared.state;

    expect(kinds(evaluate(st, snap({ setup: view("choch", "long"), now: T0 + 61 * INTERVAL })).events)).toEqual([]);

    const flipped = evaluate(st, snap({ setup: view("choch", "short"), now: T0 + 200 * INTERVAL }));
    expect(kinds(flipped.events)).toContain("setup-flipped");
    expect(flipped.events.find((x) => x.kind === "setup-flipped")?.severity).toBe("act");
    st = flipped.state;

    const gone = evaluate(st, snap({ setup: view(null, null), now: T0 + 400 * INTERVAL }));
    expect(kinds(gone.events)).toContain("setup-expired");
    expect(gone.events.find((x) => x.kind === "setup-expired")?.what).toContain("choch");
  });

  /**
   * ABSENT IS NOT FALSE, AND THIS IS THE BUG THAT PROVED IT.
   *
   * `setupView` returns null when the Setup card REFUSES to render — the
   * loaded symbol, the loaded timeframe, the series in hand and the derived
   * studies disagreeing for a frame — not when there is no setup. Treating
   * each of those frames as "the setup went away" produced, on a cold load of
   * BTCUSDT 1h: a setup appearing, price "entering" an entry zone it had never
   * left, the trade standing down, and the setup expiring. Four events
   * describing one flicker.
   */
  it("holds everything it knows through a frame with no setup in it", () => {
    const live: LiveSetup = { verdict: verdictAt("go"), plan: planAt(), direction: "long" };
    const inZone = barsFrom([...calmCloses(39), 100]);

    let st = primed(snap({ setup: live, bars: inZone }));
    /* The card blinks out for a frame … */
    const blink = evaluate(st, snap({ setup: null, bars: inZone, now: T0 + 60 * INTERVAL }));
    expect(blink.events).toEqual([]);
    expect(blink.state.strategy).toBe("choch");
    st = blink.state;

    /* … and comes back unchanged. Nothing happened, so nothing is said. */
    const back = evaluate(st, snap({ setup: live, bars: inZone, now: T0 + 61 * INTERVAL }));
    expect(back.events).toEqual([]);
  });

  /**
   * A gate blocking takes the PLAN away, not the setup. Reading direction off
   * a null plan would make every stand-down look like the setup expiring.
   */
  it("does not report a flip when a gate merely withdraws the plan", () => {
    const st = primed(snap({ setup: { verdict: verdictAt("go"), plan: planAt(), direction: "long" } }));
    const r = evaluate(
      st,
      snap({ setup: { verdict: verdictAt("stand-down"), plan: null, direction: "long" }, now: T0 + 60 * INTERVAL }),
    );
    expect(kinds(r.events)).not.toContain("setup-flipped");
    expect(kinds(r.events)).not.toContain("setup-expired");
  });
});

/* ───────────────────────────────────────────── what only a closed bar can say */

describe("structure", () => {
  const bars = barsFrom(calmCloses(60));
  const det = (over: Partial<Detection> = {}): Detection => ({
    id: "choch-1",
    kind: "choch",
    label: "Change of character",
    direction: "long",
    from: 50,
    to: bars.length - 1,
    confidence: 0.8,
    reason: "Closed above the last lower high at 100.1000.",
    shapes: [],
    ...over,
  });

  /** Prime on a series one bar short, then hand over the bar that closes. */
  const opening = (): LiveState => primed(snap({ bars: bars.slice(0, -1) }));

  it("reports a change of character confirmed on the bar that just closed", () => {
    const r = evaluate(opening(), snap({ bars, detections: [det()] }));
    const e = r.events.find((x) => x.kind === "structure-break");
    expect(e?.severity).toBe("act");
    expect(e?.barTime).toBe((bars[bars.length - 1] as BarView).t);
    /* The detector's own sentence, plus this engine's floor named explicitly. */
    expect(e?.because).toContain("Closed above the last lower high at 100.1000.");
    expect(e?.because).toContain(`minimum ${STRUCTURE_MIN_CONFIDENCE}`);
  });

  it("calls a break of structure a watch and a change of character an act", () => {
    const bos = evaluate(opening(), snap({ bars, detections: [det({ id: "bos-1", kind: "bos" })] }));
    expect(bos.events.find((x) => x.kind === "structure-break")?.severity).toBe("watch");
  });

  it("holds the confidence floor", () => {
    const under = evaluate(opening(), snap({ bars, detections: [det({ confidence: STRUCTURE_MIN_CONFIDENCE - 0.01 })] }));
    expect(kinds(under.events)).not.toContain("structure-break");
    const on = evaluate(opening(), snap({ bars, detections: [det({ confidence: STRUCTURE_MIN_CONFIDENCE })] }));
    expect(kinds(on.events)).toContain("structure-break");
  });

  /* A structure that confirmed twenty bars ago is not news, whatever the
     detector list still says about it. */
  it("ignores a structure that confirmed on an older bar", () => {
    const r = evaluate(opening(), snap({ bars, detections: [det({ to: bars.length - 20 })] }));
    expect(kinds(r.events)).not.toContain("structure-break");
  });

  it("reports one break once, however many times the detector republishes it", () => {
    const first = evaluate(opening(), snap({ bars, detections: [det()] }));
    expect(kinds(first.events)).toContain("structure-break");
    const again = evaluate(first.state, snap({ bars, detections: [det()], now: T0 + 500 * INTERVAL }));
    expect(kinds(again.events)).not.toContain("structure-break");
  });
});

describe("the outlier test", () => {
  /* Alternating ±0.1% gives a known, small EWMA sigma; the last bar is then
     pushed far enough to clear three of them and no further. */
  const calm = calmCloses(200);

  it("reports a bar that moved past the sigma threshold, and ignores one that did not", () => {
    const quiet = barsFrom([...calm, 100.05]);
    const st = primed(snap({ bars: quiet.slice(0, -1) }));
    expect(kinds(evaluate(st, snap({ bars: quiet })).events)).not.toContain("outlier-bar");

    const loud = barsFrom([...calm, 101]);
    const r = evaluate(primed(snap({ bars: loud.slice(0, -1) })), snap({ bars: loud }));
    const e = r.events.find((x) => x.kind === "outlier-bar");
    expect(e?.severity).toBe("watch");
    expect(e?.because).toContain(`Alert at ${OUTLIER_SIGMA}×`);
    const z = e?.values.find((v) => v.label === "Standardised");
    expect(z?.unit).toBe("sigma");
    expect(z?.value).toBeGreaterThanOrEqual(OUTLIER_SIGMA);
  });

  /**
   * NO LOOKAHEAD. The sigma is measured on the bars strictly BEFORE the one
   * being judged; a sigma that included the outlier would be inflated by it and
   * the bar would test as ordinary. Same rule `standardisedReturns` enforces.
   */
  it("measures sigma on the bars before the one it is judging", () => {
    const loud = barsFrom([...calm, 101]);
    const e = evaluate(primed(snap({ bars: loud.slice(0, -1) })), snap({ bars: loud })).events.find(
      (x) => x.kind === "outlier-bar",
    );
    expect(e?.because).toContain(`the ${calm.length} bars before it`);
  });
});

describe("volume", () => {
  const base = calmCloses(120);

  const withVolumes = (spike: number): BarView[] => {
    const list = barsFrom(base);
    const last = list[list.length - 1] as BarView;
    return [...list.slice(0, -1), { ...last, v: spike }];
  };

  it("holds the multiple-of-median threshold", () => {
    const under = withVolumes(VOLUME_SPIKE_X * 1000 - 1);
    expect(kinds(evaluate(primed(snap({ bars: under.slice(0, -1) })), snap({ bars: under })).events)).not.toContain(
      "volume-spike",
    );

    const over = withVolumes(VOLUME_SPIKE_X * 1000);
    const e = evaluate(primed(snap({ bars: over.slice(0, -1) })), snap({ bars: over })).events.find(
      (x) => x.kind === "volume-spike",
    );
    expect(e?.severity).toBe("info");
    /* `quantity`, not `count`: volume is a traded amount in the instrument's own
       unit and is fractional on most of them. MEASURED on BTCUSDT 1m as 10.21716
       against a median of 2.645215, which the count renderer printed as ten over
       three. */
    expect(e?.values).toContainEqual({ label: "Median", value: 1000, unit: "quantity" });
    expect(e?.values).toContainEqual({ label: "Threshold", value: VOLUME_SPIKE_X, unit: "multiple" });
    expect(e?.because).toContain(`last ${VOLUME_WINDOW} bars`);
  });

  /**
   * REFUSES rather than approximating. Plenty of feeds report no volume at all,
   * and `0 x 3` is a threshold every single bar clears — the spike would fire
   * on every close for ever.
   */
  it("says nothing on a feed that reports no volume", () => {
    const silent = barsFrom(base, 0.2, 0);
    const r = evaluate(primed(snap({ bars: silent.slice(0, -1) })), snap({ bars: silent }));
    expect(kinds(r.events)).not.toContain("volume-spike");
  });

  it("says nothing before it has a full window to take a median over", () => {
    const short = barsFrom(calmCloses(VOLUME_WINDOW - 5));
    const spiked = [...short.slice(0, -1), { ...(short[short.length - 1] as BarView), v: 100_000 }];
    const r = evaluate(primed(snap({ bars: spiked.slice(0, -1) })), snap({ bars: spiked }));
    expect(kinds(r.events)).not.toContain("volume-spike");
  });
});

describe("volatility", () => {
  /**
   * PRIME ON THE QUIET HISTORY, THEN WIDEN.
   *
   * Priming on the loud series would latch `vol:loud` in silence, which is the
   * engine doing exactly the right thing — volatility that has been in the top
   * fifth since before you opened the chart did not just happen — and would
   * make this test assert nothing at all.
   */
  const narrow = barsFrom(calmCloses(240), 0.2);
  const wide = barsFrom(calmCloses(4, 100, 4), 4).map((b, i) => ({ ...b, t: T0 + (240 + i) * INTERVAL }));

  it("reports a shift into the top fifth of its own history, once", () => {
    const st = primed(snap({ bars: narrow }));
    const r = evaluate(st, snap({ bars: [...narrow, wide[0] as BarView] }));
    const e = r.events.find((x) => x.kind === "volatility-shift");
    expect(e?.severity).toBe("watch");
    expect(e?.what).toContain("top 20%");
    const pct = e?.values.find((v) => v.label === "Percentile");
    expect(pct?.value).toBeGreaterThanOrEqual(VOLATILE_PCTILE);
    expect(e?.values).toContainEqual({ label: "Threshold", value: VOLATILE_PCTILE, unit: "percentile" });
    /* Both ends of the band named, so the sentence is checkable. */
    expect(e?.because).toContain(`above ${Math.round(VOLATILE_PCTILE * 100)}%`);
    expect(e?.because).toContain(`below ${Math.round(QUIET_PCTILE * 100)}%`);

    /* Held, not repeated: the next close is still in the top fifth. */
    const held = evaluate(r.state, snap({ bars: [...narrow, ...wide.slice(0, 2)] }));
    expect(kinds(held.events)).not.toContain("volatility-shift");
  });

  it("reports the quiet end of the band too", () => {
    const loud = barsFrom(calmCloses(240, 100, 4), 4);
    const calm = barsFrom(calmCloses(60, 100, 0.1), 0.2).map((b, i) => ({ ...b, t: T0 + (240 + i) * INTERVAL }));
    let st = primed(snap({ bars: loud }));
    const said: string[] = [];
    for (let i = 1; i <= calm.length; i++) {
      const r = evaluate(st, snap({ bars: [...loud, ...calm.slice(0, i)] }));
      st = r.state;
      for (const e of r.events) if (e.kind === "volatility-shift") said.push(e.what);
    }
    expect(said.length).toBe(1);
    expect(said[0]).toContain("bottom 20%");
  });

  /**
   * THE FIRST RANKING IS A READING, NOT A SHIFT — the same rule the regime
   * follows, added for the same measured reason. A chart whose history arrives
   * in two parts ranks the ATR over a fraction of it and then over all of it,
   * and the second ranking is a statement about the archive finishing.
   */
  it("says nothing the first time it ranks the band", () => {
    const loud = barsFrom(calmCloses(300, 100, 4), 4);
    /* Primed before it had bars, so the first close is also the first ranking. */
    const cold = evaluate(emptyState(), snap({ bars: [], now: T0 })).state;
    expect(cold.volBand).toBeNull();
    const r = evaluate(cold, snap({ bars: loud }));
    expect(kinds(r.events)).not.toContain("volatility-shift");
    expect(r.state.volBand).not.toBeNull();
  });

  /**
   * REFUSES under `VOL_MIN_SAMPLE` readings. A percentile over twenty numbers
   * is a shape, not a measurement, and "top fifth" on the strength of it would
   * be a claim nobody could check.
   */
  it("refuses to rank a percentile it has too few readings for", () => {
    const thin = barsFrom(calmCloses(45));
    const r = evaluate(primed(snap({ bars: thin.slice(0, -1) })), snap({ bars: thin }));
    expect(kinds(r.events)).not.toContain("volatility-shift");
  });
});

describe("regime", () => {
  /**
   * THE FIRST CLASSIFICATION IS A READING, NOT A CHANGE. It latches so the next
   * close does not report it as one, and it says nothing, because there is no
   * previous regime for the sentence to name.
   *
   * The priming snapshot usually IS that first classification, so the silent
   * path is exercised here from a state that has bars but has never classified
   * — an engine primed before the series arrived, which is the real sequence on
   * a cold load.
   */
  it("says nothing on the first close it classifies", () => {
    const bars = barsFrom(calmCloses(300));
    const cold = evaluate(emptyState(), snap({ bars: [], now: T0 })).state;
    expect(cold.regime).toBeNull();
    const r = evaluate(cold, snap({ bars }));
    expect(kinds(r.events)).not.toContain("regime-change");
    expect(r.state.regime).not.toBeNull();
  });

  it("reports a change once, naming both regimes", () => {
    const chop = calmCloses(300);
    /* A hard, one-sided run: ADX climbs past its threshold and the label moves
       off the sideways default. */
    const trending: number[] = [];
    for (let i = 0; i < 80; i++) trending.push(100 + i * 2);
    const all = barsFrom([...chop, ...trending]);

    let st = primed(snap({ bars: all.slice(0, 301) }));
    const seenKinds: string[] = [];
    let changes = 0;
    for (let n = 302; n <= all.length; n++) {
      const r = evaluate(st, snap({ bars: all.slice(0, n) }));
      st = r.state;
      for (const e of r.events) {
        seenKinds.push(e.kind);
        if (e.kind === "regime-change") {
          changes++;
          expect(e.what).toMatch(/changed: .+ → .+/);
          expect(e.because.length).toBeGreaterThan(10);
        }
      }
    }
    expect(changes).toBeGreaterThan(0);
    expect(st.regime).not.toBe("chop");
  });
});

/* ─────────────────────────────────────────────── the machinery, on its own */

describe("the cool-off", () => {
  const cfg = { ...DEFAULT_CONFIG, coolOffMs: 120_000 };
  const open = { verdict: verdictAt("go"), plan: null, direction: "long" as const };
  const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };

  it("bars a key that flickers back inside the window, and lets it through after", () => {
    let st = evaluate(emptyState(), snap({ setup: shut, now: T0 }), cfg).state;

    const first = evaluate(st, snap({ setup: open, now: T0 + 1_000 }), cfg);
    expect(kinds(first.events)).toContain("gates-cleared");
    st = first.state;

    st = evaluate(st, snap({ setup: shut, now: T0 + 2_000 }), cfg).state;

    /* 30s later: inside the 120s cool-off, so the same key stays quiet. */
    const flicker = evaluate(st, snap({ setup: open, now: T0 + 31_000 }), cfg);
    expect(kinds(flicker.events)).not.toContain("gates-cleared");
    st = flicker.state;

    st = evaluate(st, snap({ setup: shut, now: T0 + 40_000 }), cfg).state;

    /* Past it: a genuine second transition is reported. */
    const later = evaluate(st, snap({ setup: open, now: T0 + 200_000 }), cfg);
    expect(kinds(later.events)).toContain("gates-cleared");
  });

  it("forgets a cool-off it no longer needs, so the map cannot grow for ever", () => {
    let st = evaluate(emptyState(), snap({ setup: shut, now: T0 }), cfg).state;
    st = evaluate(st, snap({ setup: open, now: T0 + 1_000 }), cfg).state;
    st = evaluate(st, snap({ setup: shut, now: T0 + 2_000 }), cfg).state;
    expect(Object.keys(st.firedAt)).toContain("gates:clear");
    st = evaluate(st, snap({ setup: shut, now: T0 + 500_000 }), cfg).state;
    expect(Object.keys(st.firedAt)).not.toContain("gates:clear");
  });
});

describe("the ring buffer", () => {
  it("caps at seenCap, newest first, dropping the oldest", () => {
    const cfg = { coolOffMs: 0, seenCap: 5 };
    let st = evaluate(emptyState(), snap({ market: "open", now: T0 }), cfg).state;
    for (let i = 1; i <= 20; i++) {
      st = evaluate(st, snap({ market: i % 2 === 0 ? "open" : "closed", now: T0 + i * 1_000 }), cfg).state;
    }
    expect(st.seen.length).toBe(5);
    /* Newest first: the log reads top-down in reverse chronological order. */
    const times = st.seen.map((e) => e.time);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(times[0]).toBe(T0 + 20_000);
  });

  it("defaults to 200", () => {
    expect(DEFAULT_CONFIG.seenCap).toBe(200);
  });

  /**
   * Clearing the list is the operator saying "I have read these", not "pretend
   * the market is new". A clear that reset the latches would refill the panel
   * with every condition that happens to be true right now.
   */
  it("clears the log without disarming the latches", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    const open = { verdict: verdictAt("go"), plan: null, direction: "long" as const };
    let st = primed(snap({ setup: shut }));
    st = evaluate(st, snap({ setup: open, now: T0 + 60 * INTERVAL })).state;
    expect(st.seen.length).toBeGreaterThan(0);

    const cleared = clearSeen(st);
    expect(cleared.seen).toEqual([]);
    expect(cleared.activeTick).toEqual(st.activeTick);

    const after = evaluate(cleared, snap({ setup: open, now: T0 + 61 * INTERVAL }));
    expect(after.events).toEqual([]);
  });
});

describe("switching instrument", () => {
  it("resets every latch but keeps the log, which carries its own symbol", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    let st = primed(snap({ setup: shut, market: "open" }));
    st = evaluate(st, snap({ setup: shut, market: "closed", now: T0 + 60 * INTERVAL })).state;
    expect(st.seen.length).toBe(1);

    /* A new instrument: nothing fires on its first snapshot, and the old
       event is still readable. */
    const moved = evaluate(st, snap({ symbol: "XAUUSD", market: "closed", now: T0 + 61 * INTERVAL }));
    expect(moved.events).toEqual([]);
    expect(moved.state.seen.length).toBe(1);
    expect(moved.state.seen[0]?.symbol).toBe("BTCUSDT");
    expect(moved.state.key).toBe("XAUUSD|1m");

    /* And the latch really did reset rather than carrying gold's conditions
       over: coming back to a still-closed venue on the new instrument reports
       it once, from scratch. */
    const back = evaluate(
      moved.state,
      snap({ symbol: "XAUUSD", market: "open", now: T0 + 200 * INTERVAL }),
    );
    expect(kinds(back.events)).toEqual(["session-open"]);
  });

  it("gives every event a unique id across a switch", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    const open = { verdict: verdictAt("go"), plan: null, direction: "long" as const };
    let st = primed(snap({ setup: shut }));
    st = evaluate(st, snap({ setup: open, now: T0 + 60 * INTERVAL })).state;
    st = evaluate(st, snap({ symbol: "XAUUSD", setup: shut, now: T0 + 61 * INTERVAL })).state;
    st = evaluate(st, snap({ symbol: "XAUUSD", setup: open, now: T0 + 120 * INTERVAL })).state;
    const ids = st.seen.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the forming bar", () => {
  /**
   * THE OFF-BY-ONE THIS FIELD EXISTS TO PREVENT.
   *
   * `shell.ts` runs the detectors over `bars.slice(0, closedBarCount())` and a
   * detection's `to` is an index into THAT array. The engine therefore has to
   * measure the same prefix, or a structure event looks up a candle nobody
   * detected anything on. Here the caller says the last bar is still forming,
   * so the break that confirmed on the one before it is the one reported.
   */
  it("measures the prefix the caller says is closed, not one bar more", () => {
    const bars = barsFrom(calmCloses(60));
    const forming = bars.length - 1;
    const det: Detection = {
      id: "choch-1",
      kind: "choch",
      label: "Change of character",
      direction: "long",
      from: 50,
      to: forming - 1,
      confidence: 0.8,
      reason: "Closed above the last lower high at 100.1000.",
      shapes: [],
    };
    const st = primed(snap({ bars: bars.slice(0, forming - 1), closedLen: forming - 1 }));
    const r = evaluate(st, snap({ bars, closedLen: forming, detections: [det] }));
    const e = r.events.find((x) => x.kind === "structure-break");
    expect(e?.barTime).toBe((bars[forming - 1] as BarView).t);
  });

  it("treats a forming bar's close as the live price, not as a closed bar", () => {
    const bars = barsFrom([...calmCloses(39), 97.5]);
    const plan = planAt();
    const setup: LiveSetup = { verdict: verdictAt("armed"), plan, direction: "long" };
    const st = primed(snap({ bars: barsFrom(calmCloses(39)), closedLen: 39, setup }));
    /* The last bar has not closed, so nothing is measured on it — but its close
       IS the last print, and the stop check is a per-tick check. */
    const r = evaluate(st, snap({ bars, closedLen: bars.length - 1, setup }));
    expect(kinds(r.events)).toContain("stop-approach");
    expect(r.state.lastClosedBarTime).toBe((bars[bars.length - 2] as BarView).t);
  });
});

describe("the evaluator itself", () => {
  it("is pure: the same inputs produce the same events twice", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    const open = { verdict: verdictAt("go"), plan: planAt(), direction: "long" as const };
    const st = primed(snap({ setup: shut }));
    const s = snap({ setup: open, now: T0 + 60 * INTERVAL });
    const a = evaluate(st, s);
    const b = evaluate(st, s);
    expect(a.events).toEqual(b.events);
    expect(a.state).toEqual(b.state);
  });

  it("takes its clock from the snapshot, never from the machine", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    const open = { verdict: verdictAt("go"), plan: null, direction: "long" as const };
    const st = primed(snap({ setup: shut }));
    const r = evaluate(st, snap({ setup: open, now: 42 }));
    expect(r.events[0]?.time).toBe(42);
  });

  /* Every event has to be renderable and auditable: a sentence, a reason, and
     numbers that are numbers. */
  it("gives every event a sentence, a reason and numeric values", () => {
    const shut = { verdict: verdictAt("stand-down"), plan: planAt(), direction: "long" as const };
    let st = primed(snap({ setup: shut, market: "open" }));
    const r = evaluate(
      st,
      snap({
        setup: { verdict: verdictAt("go"), plan: planAt(), direction: "long" },
        market: "closed",
        feed: feedAt("stale", { tickAgeMs: 400_000 }),
        bars: barsFrom([...calmCloses(39), 100]),
        now: T0 + 60 * INTERVAL,
      }),
    );
    expect(r.events.length).toBeGreaterThan(2);
    for (const e of r.events) {
      expect(e.what.endsWith(".")).toBe(true);
      expect(e.because.length).toBeGreaterThan(10);
      for (const v of e.values) expect(Number.isFinite(v.value)).toBe(true);
      expect(["info", "watch", "act"]).toContain(e.severity);
    }
  });
});

describe("createLiveEngine", () => {
  it("holds the state between pushes and clears the log on demand", () => {
    const engine = createLiveEngine();
    const shut = { verdict: verdictAt("stand-down"), plan: null, direction: "long" as const };
    const open = { verdict: verdictAt("go"), plan: null, direction: "long" as const };
    expect(engine.push(snap({ setup: shut })).events).toEqual([]);
    expect(kinds(engine.push(snap({ setup: open, now: T0 + 60 * INTERVAL })).events)).toContain("gates-cleared");
    expect(engine.state().seen.length).toBe(1);
    engine.clear();
    expect(engine.state().seen).toEqual([]);
    /* Still latched, so clearing does not refill the list. */
    expect(engine.push(snap({ setup: open, now: T0 + 61 * INTERVAL })).events).toEqual([]);
  });
});
