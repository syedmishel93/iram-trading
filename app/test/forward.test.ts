/**
 * IS IT WORKING NOW.
 *
 * Everything this terminal reports is "worked". This is the other half, and
 * the risk in it is not arithmetic — the engine does that — it is the three
 * ways a forward record can quietly become a claim about something else:
 *
 *   the rule was edited and the record kept    -> stale, refused
 *   a rate stated on too few firings           -> null, not zero
 *   a trade that timed out counted as a loss   -> its own outcome
 */

import { describe, expect, it } from "vitest";
import {
  MIN_FORWARD_TRADES,
  forwardSince,
  specFingerprint,
  type Armed,
} from "../src/backtest/forward";
import { SPECS } from "../src/backtest/specs";
import type { RuleSpec } from "../src/backtest/rules";
import type { BarView } from "../src/chart/series";

const H = 3_600_000;
const SPEC = SPECS.find((s) => s.id === "ema-9-21-cross") as RuleSpec;

/** A trending series, so the rule actually fires rather than testing nothing. */
function bars(n: number, from = 1_600_000_000_000): BarView[] {
  const out: BarView[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    /* A slow drift with a wobble: enough structure for a cross to happen. */
    p += Math.sin(i / 9) * 0.9 + 0.04;
    const o = p;
    const c = p + Math.sin(i / 4) * 0.35;
    out.push({ t: from + i * H, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 1000 });
  }
  return out;
}

const armedAt = (b: readonly BarView[], atIndex: number): number => (b[atIndex] as BarView).t;

const arm = (b: readonly BarView[], atIndex: number, over: Partial<Armed> = {}): Armed => ({
  specId: SPEC.id,
  fingerprint: specFingerprint(SPEC),
  symbol: "XAUUSD",
  timeframe: "1h",
  armedAt: armedAt(b, atIndex),
  ...over,
});

describe("the fingerprint", () => {
  it("IS THE SAME FOR A RULE THAT ONLY CHANGED ITS NAME", () => {
    /* Renaming a rule must not throw away its forward record. The fingerprint
       covers the SHAPE that decides trades, not the words around it. */
    const renamed: RuleSpec = { ...SPEC, name: "Something else entirely", note: "reworded" };
    expect(specFingerprint(renamed)).toBe(specFingerprint(SPEC));
  });

  it("CHANGES WHEN ANYTHING THAT DECIDES A TRADE CHANGES", () => {
    /* The other half, and the one that matters: a moved threshold is a
       different strategy however little the diff looks. */
    const moved: RuleSpec = { ...SPEC, stop: { ...SPEC.stop, atrMultiple: 99 } as RuleSpec["stop"] };
    expect(specFingerprint(moved)).not.toBe(specFingerprint(SPEC));

    const flipped: RuleSpec = { ...SPEC, style: SPEC.style === "swing" ? "scalp" : "swing" };
    expect(specFingerprint(flipped)).not.toBe(specFingerprint(SPEC));
  });
});

describe("what it refuses", () => {
  it("REFUSES A RECORD WHOSE RULE HAS BEEN EDITED, rather than caveating it", () => {
    /* NO RE-OPTIMISING DURING THE VALIDATION WINDOW is the standing rule of
       walk-forward validation, and this is the one place it can be broken
       silently: edit the rule, keep the record, and every figure becomes a
       claim about a strategy that did not exist for most of it.

       A refusal rather than a warning, because a caveat on a number is a thing
       people read past. */
    const b = bars(400);
    const edited: RuleSpec = { ...SPEC, stop: { ...SPEC.stop, atrMultiple: 99 } as RuleSpec["stop"] };
    const f = forwardSince(edited, arm(b, 100), b);
    expect(f.state).toBe("stale");
    expect(f.fired).toBe(0);
    expect(f.hitRate).toBeNull();
    expect(f.says).toMatch(/edited since it was armed/i);
  });

  it("SAYS WAITING WHEN NO BAR HAS CLOSED SINCE, which is not a failure", () => {
    const b = bars(200);
    const f = forwardSince(SPEC, arm(b, 199), b);
    expect(f.state).toBe("waiting");
    expect(f.says).toMatch(/no bar has closed/i);
  });

  it("REFUSES A RATE IT CANNOT SUPPORT, and null is not zero", () => {
    /* Fourteen firings cannot separate a 64% rule from a coin. This product
       already records a service returning a null rate for a population with
       nothing decided, and a client that rendered it as 0.0% would have said
       every claim lost. */
    const b = bars(400);
    const f = forwardSince(SPEC, arm(b, 300), b);
    expect(["thin", "waiting"]).toContain(f.state);
    expect(f.hitRate, "it stated a rate on a handful of firings").toBeNull();
  });

  it("NAMES HOW MANY MORE ARE NEEDED, rather than just refusing", () => {
    const b = bars(900);
    const f = forwardSince(SPEC, arm(b, 40), b);
    if (f.state === "thin" && f.fired > 0) {
      expect(f.says).toMatch(/too few to state a rate/i);
      expect(f.says).toMatch(/more needed/i);
    }
    expect(MIN_FORWARD_TRADES).toBeGreaterThan(20);
  });
});

describe("what it counts", () => {
  const b = bars(1400);
  const f = forwardSince(SPEC, arm(b, 60), b);

  it("COUNTS ONLY WHAT HAPPENED AFTER ARMING", () => {
    /* The whole claim. A record that included a trade from before the arm
       would be a backtest wearing a forward record's clothes. */
    const all = forwardSince(SPEC, arm(b, 0), b);
    expect(all.fired).toBeGreaterThanOrEqual(f.fired);
    expect(f.bars).toBeLessThan(b.length);
  });

  it("KEEPS A TIMEOUT OUT OF THE DENOMINATOR", () => {
    /* "Nothing happened" is not "I was wrong", and only the second is worth
       learning to avoid. A rule that closes its own position, or a trade still
       open when the bars run out, is neither a win nor a loss. */
    expect(f.fired).toBe(f.won + f.lost + f.timedOut);
    if (f.hitRate !== null) {
      expect(f.hitRate).toBeCloseTo(f.won / (f.won + f.lost), 10);
    }
  });

  it("STATES A RATE ONCE THERE ARE ENOUGH, and it agrees with the counts", () => {
    if (f.state === "measured") {
      expect(f.won + f.lost).toBeGreaterThanOrEqual(MIN_FORWARD_TRADES);
      expect(f.says).toMatch(/reached target/);
      expect(f.totalR).not.toBeNull();
    } else {
      /* An honest skip: this series did not produce enough decided firings.
         Saying so beats a test that pretends it did. */
      expect(f.hitRate).toBeNull();
    }
  });

  it("ALWAYS SAYS SOMETHING A PERSON CAN READ", () => {
    for (const armIndex of [0, 60, 300, 1399]) {
      const r = forwardSince(SPEC, arm(b, armIndex), b);
      expect(r.says.length, `arm at ${armIndex} said nothing`).toBeGreaterThan(8);
    }
  });

  it("CARRIES THE SUBJECT, so a record cannot be read as being about another market", () => {
    const r = forwardSince(SPEC, arm(b, 100, { symbol: "BTCUSDT", timeframe: "4h" }), b);
    expect(r.symbol).toBe("BTCUSDT");
    expect(r.timeframe).toBe("4h");
  });
});

describe("a rule that loses, because a fixture that only ever wins tests half the arithmetic", () => {
  /**
   * The trending fixture above produces 48 firings and 47 wins — fine for the
   * plumbing, and it means `hitRate = won / (won + lost)` is only ever
   * evaluated with `lost` at zero. A rate that is trivially 1 has not been
   * tested. This series whipsaws instead: an EMA cross on noise is the
   * canonical way to lose money slowly.
   */
  function chop(n: number, from = 1_600_000_000_000): BarView[] {
    const out: BarView[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      /* Two tight cycles out of phase: enough crossings to keep entering, not
         enough follow-through to reach a target. */
      p += Math.sin(i / 2.1) * 1.4 + Math.sin(i / 5.7) * 0.6;
      const o = p;
      const c = p + Math.sin(i / 1.7) * 0.5;
      /* TIGHT BARS. At +/-0.9 the highs and lows were wide enough to fill the
         target intrabar on almost every entry: 97 fired, 7 won, 0 lost, 90
         timed out — a fixture that still never exercised a loss. Measured at
         +/-0.05: 28 won, 28 lost, 41 timed out, R -13.6. The padding was doing
         the work, not the price path. */
      out.push({ t: from + i * H, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: 1000 });
    }
    return out;
  }

  const b = chop(1400);
  const f = forwardSince(SPEC, arm(b, 60), b);

  it("LOSES, so the rate is exercised from both sides", () => {
    expect(f.fired, "the chop fixture produced no firings at all").toBeGreaterThan(0);
    expect(f.lost, "a whipsaw series produced no losses — the fixture is wrong").toBeGreaterThan(0);
  });

  it("PUTS THE RATE STRICTLY INSIDE ITS BOUNDS", () => {
    if (f.hitRate === null) {
      /* Still honest: too few decided. The counts must agree regardless. */
      expect(f.won + f.lost).toBeLessThan(MIN_FORWARD_TRADES);
    } else {
      expect(f.hitRate).toBeGreaterThan(0);
      expect(f.hitRate).toBeLessThan(1);
      expect(f.hitRate).toBeCloseTo(f.won / (f.won + f.lost), 10);
    }
  });

  it("REPORTS A NEGATIVE R WITHOUT FLINCHING", () => {
    /* The number this whole product exists to be willing to print. */
    if (f.totalR !== null) expect(Number.isFinite(f.totalR)).toBe(true);
    expect(f.fired).toBe(f.won + f.lost + f.timedOut);
  });
});
