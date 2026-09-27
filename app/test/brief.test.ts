/**
 * Standing briefs.
 *
 * This is the one feature in the terminal that spends money while nobody is
 * watching, so the tests that matter are the ones about NOT spending it: the
 * check floor, arming being explicit, firing disarming, and overlapping passes
 * not double-charging. The verdict parser is next, because its asymmetry —
 * anything ambiguous is a WAITING — is what stops a false alarm at 3am.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_AGE_MS,
  MIN_INTERVAL_MS,
  canArm,
  createBriefStore,
  createBriefWatcher,
  isDue,
  parseVerdict,
  type Brief,
} from "../src/agent/brief";

const brief = (over: Partial<Brief> = {}): Brief => ({
  id: "b1",
  text: "tell me when the sweep completes",
  symbol: "BTCUSDT",
  timeframe: "1h",
  createdAt: 1_000_000,
  state: "armed",
  checkedAt: null,
  checks: 0,
  firedAt: null,
  firedWhy: "",
  lastAnswer: "",
  ...over,
});

describe("parseVerdict", () => {
  it("reads a firing and keeps the sentence", () => {
    const v = parseVerdict("FIRED: the 4h sweep completed at 77,204 with the low taken.");
    expect(v.fired).toBe(true);
    expect(v.why).toMatch(/77,204/);
  });

  it("reads a waiting", () => {
    expect(parseVerdict("WAITING: price is still inside the range.").fired).toBe(false);
  });

  it("treats anything it cannot parse as WAITING, never as a firing", () => {
    /* The asymmetry, and the reason for it: a missed firing costs an
       opportunity, a false one wakes somebody up for nothing. */
    for (const text of [
      "Well, it looks like the sweep might be forming soon.",
      "",
      "I think FIRED would be appropriate here",
      "```json\n{\"fired\": true}\n```",
    ]) {
      expect(parseVerdict(text).fired, JSON.stringify(text)).toBe(false);
    }
  });

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseVerdict("   fired:  it happened").fired).toBe(true);
  });

  it("reads only the first non-empty line", () => {
    /* A model that answers correctly and then keeps talking must not have its
       verdict changed by the paragraph after it. */
    expect(parseVerdict("WAITING: not yet.\nFIRED: but soon.").fired).toBe(false);
  });
});

describe("canArm", () => {
  it("refuses the providers that cannot read a brief, and says which", () => {
    for (const id of ["offline", "local"]) {
      const r = canArm(id);
      expect(r.ok, id).toBe(false);
      expect(r.reason).toMatch(/no language model/i);
    }
  });

  it("allows a configured model-backed provider", () => {
    expect(canArm("anthropic", { ok: true }).ok).toBe(true);
    expect(canArm("openai", { ok: true }).ok).toBe(true);
  });

  it("refuses a provider that is selected but not configured", () => {
    /* The case that actually bit. `AGENT_PROVIDERS` holds only openai and
       anthropic, so an id check alone cleared a provider with no key behind
       it — and the terminal's resilient wrapper would then have had the
       offline analyst judge the brief. */
    const r = canArm("openai", { ok: false, reason: "No API key set." });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not configured/i);
    expect(r.reason).toMatch(/No API key set/);
  });
});

describe("isDue", () => {
  const T = 2_000_000;

  it("is due the first time once armed", () => {
    expect(isDue(brief(), T, T)).toBe(true);
  });

  it("is never due unless armed", () => {
    for (const state of ["idle", "fired", "expired"] as const) {
      expect(isDue(brief({ state }), T, T), state).toBe(false);
    }
  });

  it("respects the floor even when bars keep closing", () => {
    /* A 1-minute chart closes 1,440 bars a day. Without the floor that is
       1,440 paid requests per brief per day. */
    const b = brief({ checkedAt: T - 60_000 });
    expect(isDue(b, T, T)).toBe(false);
  });

  it("needs a NEW bar as well as the floor", () => {
    /* Both conditions. A quiet daily chart must not be re-checked every five
       minutes just because the clock moved. */
    const b = brief({ checkedAt: T - MIN_INTERVAL_MS - 1 });
    expect(isDue(b, T, T - MIN_INTERVAL_MS - 2)).toBe(false);
    expect(isDue(b, T, T)).toBe(true);
  });

  it("stops when the brief is older than the maximum age", () => {
    expect(isDue(brief({ createdAt: T - MAX_AGE_MS - 1 }), T, T)).toBe(false);
  });
});

describe("createBriefStore", () => {
  let clock = 1_000_000;
  const store = () => createBriefStore({ now: () => clock });

  it("creates briefs IDLE, never armed", () => {
    /* Creating a brief and starting to spend on it are two decisions. */
    const s = store();
    const b = s.add("watch for the sweep", "BTCUSDT", "1h");
    expect(b?.state).toBe("idle");
  });

  it("refuses an empty or trivial brief", () => {
    const s = store();
    expect(s.add("   ", "BTCUSDT", "1h")).toBeNull();
    expect(s.add("no", "BTCUSDT", "1h")).toBeNull();
    expect(s.briefs()).toHaveLength(0);
  });

  it("counts every check, fired or not", () => {
    const s = store();
    const b = s.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    s.arm(b.id);
    s.record(b.id, { fired: false, why: "still ranging" });
    s.record(b.id, { fired: false, why: "still ranging" });
    expect(s.briefs()[0]?.checks).toBe(2);
    expect(s.briefs()[0]?.lastAnswer).toBe("still ranging");
  });

  it("disarms itself when it fires", () => {
    /* Nothing retriggers on its own. The operator has been told; the brief
       stops spending until they decide it should watch again. */
    const s = store();
    const b = s.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    s.arm(b.id);
    s.record(b.id, { fired: true, why: "the low was taken at 77,204" });
    const after = s.briefs()[0] as Brief;
    expect(after.state).toBe("fired");
    expect(after.firedWhy).toMatch(/77,204/);
    expect(isDue(after, clock, clock)).toBe(false);
  });

  it("re-arming clears the previous firing", () => {
    const s = store();
    const b = s.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    s.arm(b.id);
    s.record(b.id, { fired: true, why: "done" });
    s.arm(b.id);
    expect(s.briefs()[0]).toMatchObject({ state: "armed", firedAt: null, firedWhy: "" });
  });

  it("expires armed briefs past the maximum age", () => {
    const s = store();
    const b = s.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    s.arm(b.id);
    clock += MAX_AGE_MS + 1;
    s.expireOld();
    expect(s.briefs()[0]?.state).toBe("expired");
  });
});

describe("createBriefWatcher", () => {
  const build = (
    evaluate: (b: Brief, p: string) => Promise<string>,
    blocked = "",
    clock = { t: 2_000_000 },
  ) => {
    const store = createBriefStore({ now: () => clock.t });
    const onFire = vi.fn();
    const watcher = createBriefWatcher({
      store,
      blocked: () => blocked,
      evaluate,
      lastBarCloseAt: () => clock.t,
      onFire,
      now: () => clock.t,
    });
    return { store, watcher, onFire, clock };
  };

  it("checks nothing while every brief is idle", async () => {
    const evaluate = vi.fn(async () => "FIRED: yes");
    const { store, watcher, onFire } = build(evaluate);
    store.add("watch the sweep", "BTCUSDT", "1h");
    await watcher.tick();
    expect(evaluate).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
  });

  it("checks an armed brief and reports a firing once", async () => {
    const evaluate = vi.fn(async () => "FIRED: the low was taken at 77,204.");
    const { store, watcher, onFire } = build(evaluate);
    const b = store.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    store.arm(b.id);

    await watcher.tick();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledOnce();

    /* Fired means disarmed: a second pass must cost nothing. */
    await watcher.tick();
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("will not check at all while something blocks it", async () => {
    /* The desk and the watcher ask the SAME question. In the first version one
       looked at the resilient wrapper's id and the other at the provider
       behind it, so the arm button worked and no check ever ran. */
    const evaluate = vi.fn(async () => "FIRED: yes");
    const { store, watcher } = build(evaluate, canArm("offline").reason);
    const b = store.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    store.arm(b.id);
    await watcher.tick();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("records a failed check rather than skipping it", async () => {
    /* A brief that silently stops being checked is one the operator still
       believes is watching. */
    const evaluate = vi.fn(async () => {
      throw new Error("429 rate limited");
    });
    const { store, watcher, onFire } = build(evaluate);
    const b = store.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    store.arm(b.id);
    await watcher.tick();
    const after = store.briefs()[0] as Brief;
    expect(after.checks).toBe(1);
    expect(after.state).toBe("armed");
    expect(after.lastAnswer).toMatch(/429/);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("joins an overlapping pass instead of double-charging", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const evaluate = vi.fn(async () => {
      await gate;
      return "WAITING: still ranging.";
    });
    const { store, watcher } = build(evaluate);
    const b = store.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    store.arm(b.id);

    const a = watcher.tick();
    const c = watcher.tick();
    release();
    await Promise.all([a, c]);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("checks briefs one at a time, not in parallel", async () => {
    /* Briefs share a rate limit and a bill; a burst is the shape most likely
       to trip a vendor's limiter, which fails the checks rather than
       speeding them up. */
    let inFlight = 0;
    let maxInFlight = 0;
    const evaluate = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return "WAITING: nothing yet.";
    });
    const { store, watcher } = build(evaluate);
    for (let i = 0; i < 4; i++) {
      const b = store.add(`watch number ${i}`, "BTCUSDT", "1h") as Brief;
      store.arm(b.id);
    }
    await watcher.tick();
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
  });

  it("stops checking after stop()", async () => {
    const evaluate = vi.fn(async () => "WAITING: no.");
    const { store, watcher } = build(evaluate);
    const b = store.add("watch the sweep", "BTCUSDT", "1h") as Brief;
    store.arm(b.id);
    watcher.stop();
    await watcher.tick();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
