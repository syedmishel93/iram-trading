import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXIT_RULES,
  EXIT_LIMITS,
  exitRulesAreDefault,
  invalidationOf,
  readExit,
  sanitiseExitRules,
  type OpenTrade,
} from "../src/setup/exit";
import type { BarView } from "../src/chart/series";

const HOUR = 3_600_000;

/** A rising series, so a long is in profit and a trail has something to track. */
function rising(n: number, from = 100, step = 1): BarView[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * HOUR,
    o: from + i * step,
    h: from + i * step + 0.5,
    l: from + i * step - 0.5,
    c: from + i * step,
    v: 100,
  }));
}

function flatAt(n: number, price: number): BarView[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * HOUR,
    o: price,
    h: price + 0.5,
    l: price - 0.5,
    c: price,
    v: 100,
  }));
}

const trade: OpenTrade = {
  direction: "long",
  entry: 100,
  stop: 90,
  target: 130,
  openedAtBar: 0,
  setupKind: "bos",
};

const NO_INVALIDATION = { yes: false, why: "" };

describe("sanitiseExitRules", () => {
  it("clamps on READ as well as on write", () => {
    /* A preferences file edited by hand, or written by an older build, must
       not produce a trail sitting inside the noise it was meant to clear. */
    const r = sanitiseExitRules({ trailAtr: 0.1, trailBars: 2, partialAtR: 99 });
    expect(r.trailAtr).toBe(EXIT_LIMITS.trailAtr[0]);
    expect(r.trailBars).toBe(EXIT_LIMITS.trailBars[0]);
    expect(r.partialAtR).toBe(EXIT_LIMITS.partialAtR[1]);
  });

  it("falls back to the default rather than to zero on garbage", () => {
    const r = sanitiseExitRules({ trailAtr: "banana", timeStopBars: NaN });
    expect(r.trailAtr).toBe(DEFAULT_EXIT_RULES.trailAtr);
    expect(r.timeStopBars).toBe(DEFAULT_EXIT_RULES.timeStopBars);
  });

  it("keeps zero where zero means 'switched off'", () => {
    /* Unlike the gate rules, a partial at 0R genuinely means "no partial" —
       there is no gate here being silently disabled. */
    expect(sanitiseExitRules({ partialAtR: 0 }).partialAtR).toBe(0);
    expect(sanitiseExitRules({ timeStopBars: 0 }).timeStopBars).toBe(0);
  });

  it("rounds the bar counts, which are indices and not measurements", () => {
    expect(sanitiseExitRules({ trailBars: 22.7 }).trailBars).toBe(23);
  });

  it("recognises the untouched defaults", () => {
    expect(exitRulesAreDefault(DEFAULT_EXIT_RULES)).toBe(true);
    expect(exitRulesAreDefault({ ...DEFAULT_EXIT_RULES, trailAtr: 2 })).toBe(false);
  });
});

describe("readExit", () => {
  it("reports unrealised R in units of the risk actually taken", () => {
    const bars = rising(40); // last close 139
    const r = readExit(trade, bars, DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(r).not.toBeNull();
    expect(r?.openR).toBeCloseTo(3.9, 6); // (139 − 100) / 10
  });

  it("gets the sign right on a short", () => {
    const bars = rising(40);
    const short: OpenTrade = { ...trade, direction: "short", entry: 100, stop: 110 };
    expect(readExit(short, bars, DEFAULT_EXIT_RULES, NO_INVALIDATION)?.openR).toBeCloseTo(-3.9, 6);
  });

  it("refuses rather than dividing by a zero stop distance", () => {
    expect(readExit({ ...trade, stop: 100 }, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION))
      .toBeNull();
  });

  it("returns null when the open bar is outside the loaded series", () => {
    expect(readExit({ ...trade, openedAtBar: 500 }, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION))
      .toBeNull();
    expect(readExit(trade, [], DEFAULT_EXIT_RULES, NO_INVALIDATION)).toBeNull();
  });

  it("offers break-even only once it has been earned", () => {
    const early = readExit(trade, rising(5), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(early?.breakEven).toBeNull();
    const later = readExit(trade, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(later?.breakEven).toBe(100);
  });

  /**
   * BOTH trails are reported and the tighter is NAMED, never silently chosen.
   *
   * Which method is better is a measured question that belongs to the lab and
   * the journal. A default picked in `exit.ts` would pre-empt the measurement
   * and nobody would ever find out.
   */
  it("reports the ATR trail and the structural trail side by side", () => {
    const r = readExit(trade, rising(60), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(r?.atrTrail).not.toBeNull();
    expect(r?.structureTrail).not.toBeNull();
    const trail = r?.suggestions.find((s) => s.reason === "trail");
    expect(trail?.text).toMatch(/ATR/);
    expect(trail?.text).toMatch(/structure/);
    expect(trail?.text).toMatch(/is tighter at/);
  });

  it("puts both trails below price for a long", () => {
    const bars = rising(60);
    const r = readExit(trade, bars, DEFAULT_EXIT_RULES, NO_INVALIDATION);
    const price = (bars[bars.length - 1] as BarView).c;
    expect(r?.atrTrail as number).toBeLessThan(price);
    expect(r?.structureTrail as number).toBeLessThan(price);
  });

  it("marks the partial as due once the R multiple is reached", () => {
    const r = readExit(trade, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    const partial = r?.suggestions.find((s) => s.reason === "target");
    expect(partial?.triggered).toBe(true);
    expect(partial?.level).toBeCloseTo(110, 6);
  });

  it("does not offer a partial that is switched off", () => {
    const r = readExit(
      trade,
      rising(40),
      { ...DEFAULT_EXIT_RULES, partialAtR: 0 },
      NO_INVALIDATION,
    );
    expect(r?.suggestions.some((s) => s.reason === "target")).toBe(false);
  });

  /**
   * The time stop fires only while the trade is going NOWHERE.
   *
   * A position 3R up after 40 bars is not stale, it is working, and a time
   * stop that closed it would be the rule doing active harm.
   */
  it("fires the time stop on a stalled trade and not on a working one", () => {
    const stalled = readExit(trade, flatAt(40, 100), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(stalled?.suggestions.some((s) => s.reason === "time" && s.triggered)).toBe(true);

    const working = readExit(trade, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(working?.suggestions.some((s) => s.reason === "time" && s.triggered)).toBe(false);
  });

  it("does not fire a time stop that is switched off", () => {
    const r = readExit(
      trade,
      flatAt(40, 100),
      { ...DEFAULT_EXIT_RULES, timeStopBars: 0 },
      NO_INVALIDATION,
    );
    expect(r?.suggestions.some((s) => s.reason === "time")).toBe(false);
  });

  /**
   * The headline is ordered by CONSEQUENCE, not by rule number.
   *
   * An invalidation says the trade is no longer the trade. A partial says a
   * routine bit of housekeeping is due. Showing the second while the first is
   * true would be the single worst ordering bug available here.
   */
  it("puts invalidation above every other trigger in the headline", () => {
    const r = readExit(trade, rising(40), DEFAULT_EXIT_RULES, {
      yes: true,
      why: "break of structure against you since you opened",
    });
    expect(r?.headline?.reason).toBe("invalidation");
    expect(r?.headline?.text).toMatch(/no longer the setup you entered/);
  });

  it("has no headline when nothing needs doing", () => {
    const r = readExit(trade, rising(3), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(r?.headline).toBeNull();
  });

  it("counts bars held from the bar the position was opened at", () => {
    const r = readExit({ ...trade, openedAtBar: 10 }, rising(40), DEFAULT_EXIT_RULES, NO_INVALIDATION);
    expect(r?.barsHeld).toBe(29);
  });
});

describe("invalidationOf", () => {
  const det = (over: Partial<{ kind: string; direction: "long" | "short" | "neutral"; to: number; label: string }>) => ({
    kind: "bos",
    direction: "short" as const,
    to: 10,
    label: "Break of structure",
    ...over,
  });

  it("fires on a structure break against the position, after it was opened", () => {
    const r = invalidationOf({ ...trade, openedAtBar: 5 }, [det({})]);
    expect(r.yes).toBe(true);
    expect(r.why).toMatch(/break of structure/i);
  });

  /**
   * The test is deliberately narrow.
   *
   * On a busy chart something bearish appears every few bars. An invalidation
   * that fires constantly is one you learn to dismiss, which costs you the one
   * time it mattered — so only a STRUCTURE break counts, not any bearish mark.
   */
  it("ignores a non-structural detection pointing the other way", () => {
    expect(invalidationOf({ ...trade, openedAtBar: 5 }, [det({ kind: "fvg" })]).yes).toBe(false);
    expect(invalidationOf({ ...trade, openedAtBar: 5 }, [det({ kind: "divergence" })]).yes).toBe(false);
  });

  it("ignores structure that broke BEFORE the trade was opened", () => {
    /* It was already on the chart when the position was taken. Treating it as
       news would invalidate every trade the moment it was entered. */
    expect(invalidationOf({ ...trade, openedAtBar: 20 }, [det({ to: 10 })]).yes).toBe(false);
  });

  it("ignores structure pointing the SAME way as the position", () => {
    expect(invalidationOf({ ...trade, openedAtBar: 5 }, [det({ direction: "long" })]).yes).toBe(false);
    expect(invalidationOf({ ...trade, openedAtBar: 5 }, [det({ direction: "neutral" })]).yes).toBe(false);
  });

  it("accepts a change of character as well as a break of structure", () => {
    const r = invalidationOf({ ...trade, openedAtBar: 5 }, [
      det({ kind: "choch", label: "Change of character" }),
    ]);
    expect(r.yes).toBe(true);
  });

  it("inverts correctly for a short", () => {
    const short: OpenTrade = { ...trade, direction: "short", openedAtBar: 5 };
    expect(invalidationOf(short, [det({ direction: "short" })]).yes).toBe(false);
    expect(invalidationOf(short, [det({ direction: "long" })]).yes).toBe(true);
  });

  it("returns no reason when there is nothing to report", () => {
    expect(invalidationOf(trade, [])).toEqual({ yes: false, why: "" });
  });
});
