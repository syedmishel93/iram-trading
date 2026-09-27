/**
 * The evidence supervisor.
 *
 * Every test here is driven by a fake clock and a fake timer queue, because the
 * behaviour that matters is what happens over HOURS — a service that comes back
 * at lunchtime, an answer that goes stale overnight — and none of that is
 * reachable by waiting.
 *
 * The bug being prevented has now been reported three times in three different
 * shapes, all of them arriving as "it is always stand down".
 */

import { describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MS,
  createSupervisor,
  supervisorLine,
  type LaneSpec,
  type SupervisorHandle,
} from "../src/setup/supervisor";

/** A clock and a timer queue you can wind forward by hand. */
function harness() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => t,
    setTimer: (fn: () => void, ms: number): number => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: number): void => {
      timers.delete(id);
    },
    pending: (): number => timers.size,
    /** Advance the clock, firing anything that comes due, in order. */
    advance: async (ms: number): Promise<void> => {
      const until = t + ms;
      /* Drain first. `watch()` asks synchronously, so at the moment advance is
         called the opening requests are still unsettled and no timer has been
         armed yet — the loop below would find nothing to fire and return
         having done nothing at all. */
      for (let i = 0; i < 8; i++) await Promise.resolve();
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= until && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId < 0) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        t = nextAt;
        timer?.fn();
        /* Enough ticks for `Promise.resolve().then(refresh).then(settle)` to
           run to completion, including the extra tick an async `refresh` costs
           while its promise is adopted. Too few and every lane looks stuck in
           flight, which is a harness failure that reads exactly like a bug. */
        for (let i = 0; i < 8; i++) await Promise.resolve();
      }
      t = until;
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    /** Let queued promise callbacks run without moving the clock. */
    flush: async (): Promise<void> => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

/**
 * A lane whose answer and outcome you control.
 *
 * `answeredAt` is a real timestamp rather than a boolean because staleness is
 * half of what this module does, and a mock that cannot age cannot test it.
 */
function lane(
  id: string,
  h: ReturnType<typeof harness>,
  over: Partial<LaneSpec> = {},
): LaneSpec & { answers: boolean; calls: number; setAnswered: (t: number | null) => void } {
  let answered: number | null = null;
  const spec = {
    id,
    label: id,
    answers: true,
    calls: 0,
    applies: () => true,
    answeredAt: () => answered,
    setAnswered: (v: number | null) => {
      answered = v;
    },
    refresh: async (): Promise<void> => {
      spec.calls++;
      if (spec.answers) answered = h.now();
    },
    ...over,
  };
  return spec as LaneSpec & { answers: boolean; calls: number; setAnswered: (t: number | null) => void };
}

const stateOf = (s: SupervisorHandle, id: string): string =>
  s.status().find((x) => x.id === id)?.state ?? "missing";

describe("asking once, when once is enough", () => {
  it("asks a lane that has never answered, and then leaves it alone", async () => {
    const h = harness();
    const a = lane("models", h);
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.flush();

    expect(a.calls).toBe(1);
    expect(stateOf(sup, "models")).toBe("fresh");
    expect(sup.settled()).toBe(true);

    await h.advance(60_000);
    expect(a.calls).toBe(1);
    sup.stop();
  });

  it("never asks a lane that cannot answer for this instrument", async () => {
    /* Gold has no Binance perpetual. Asking anyway is not merely wasted: the
       measured cost was seven outbound requests per symbol change on a gold
       chart, four of them to a futures API, and Binance answers too-much with
       a ban that gets longer each time you retry into it. */
    const h = harness();
    const derivs = lane("derivatives", h, { applies: () => false });
    const sup = createSupervisor({
      lanes: [derivs],
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sup.watch("XAUUSD|1h");
    await h.advance(60 * 60_000);

    expect(derivs.calls).toBe(0);
    expect(stateOf(sup, "derivatives")).toBe("absent");
    expect(sup.settled()).toBe(true);
    sup.stop();
  });
});

describe("not giving up", () => {
  it("keeps asking a failing lane for hours, on a widening backoff", async () => {
    /* THE REGRESSION, AND THE REASON THIS FILE EXISTS.
       The previous warm-up retried at 6s, 20s and 60s and then stopped. A
       service started two minutes after the terminal was never asked again,
       and the card carried a permanent, unexplained STAND DOWN for the rest of
       the session. */
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.flush();
    expect(a.calls).toBe(1);

    await h.advance(90_000);
    const early = a.calls;
    expect(early).toBeGreaterThan(2);

    await h.advance(4 * 60 * 60_000);
    expect(a.calls).toBeGreaterThan(early + 20);
    expect(stateOf(sup, "models")).toBe("failed");
    sup.stop();
  });

  it("widens the gap rather than hammering", async () => {
    /* The other half of "permanent" is "affordable". Four hours of a service
       being switched off must not be four hours of requests every four
       seconds. */
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.advance(4 * 60 * 60_000);

    const ceiling = BACKOFF_MS[BACKOFF_MS.length - 1] as number;
    const floor = Math.floor((4 * 60 * 60_000) / ceiling);
    /* Generous upper bound: the early attempts are fast by design. What is
       being pinned is that it settles onto the ceiling instead of the floor. */
    expect(a.calls).toBeLessThan(floor + BACKOFF_MS.length + 4);
    sup.stop();
  });

  it("picks a lane back up the moment it starts answering", async () => {
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.advance(120_000);
    expect(stateOf(sup, "models")).toBe("failed");

    a.answers = true;
    await h.advance(15 * 60_000);
    expect(stateOf(sup, "models")).toBe("fresh");
    expect(sup.settled()).toBe(true);
    sup.stop();
  });

  it("survives a lane that rejects, and records why", async () => {
    const h = harness();
    const a = lane("models", h, {
      refresh: () => Promise.reject(new Error("connection refused")),
    });
    const b = lane("calendar", h);
    const sup = createSupervisor({
      lanes: [a, b],
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sup.watch("XAUUSD|1h");
    await h.advance(10_000);

    expect(stateOf(sup, "calendar")).toBe("fresh");
    expect(sup.status().find((s) => s.id === "models")?.lastError).toBe("connection refused");
    sup.stop();
  });
});

describe("staleness, which the old code could not see at all", () => {
  it("re-asks an answer that has aged past what it describes", async () => {
    /* A regime fitted twenty minutes ago on a one-minute chart was fitted on a
       series twenty bars shorter than the one on screen. `null` was the only
       state the old code had, and a stale answer is not null. */
    const h = harness();
    const a = lane("models", h, { maxAgeMs: 10 * 60_000 });
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.flush();
    expect(a.calls).toBe(1);

    await h.advance(9 * 60_000);
    expect(a.calls).toBe(1);

    await h.advance(2 * 60_000);
    expect(a.calls).toBe(2);
    expect(stateOf(sup, "models")).toBe("fresh");
    sup.stop();
  });
});

describe("the instrument on screen", () => {
  it("forgets the previous instrument's failures", async () => {
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.advance(10 * 60_000);
    expect(sup.status()[0]?.attempts).toBeGreaterThan(3);

    a.answers = true;
    a.setAnswered(null);
    sup.watch("BTCUSDT|1h");
    await h.flush();
    expect(sup.status()[0]?.attempts).toBe(0);
    expect(stateOf(sup, "models")).toBe("fresh");
    sup.stop();
  });

  it("discards an answer that lands after the instrument moved on", async () => {
    /* The same mistake as a plan built from one series and checked against
       another: a success recorded against the wrong chart is worse than a
       failure, because nothing goes back for it. */
    const h = harness();
    const releases: (() => void)[] = [];
    const a = lane("models", h, {
      refresh: () =>
        new Promise<void>((res) => {
          releases.push(res);
        }),
    });
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.flush();
    expect(releases).toHaveLength(1);

    sup.watch("BTCUSDT|1h");
    await h.flush();
    /* Resolve the request that went out for the PREVIOUS instrument, while the
       new one has its own in flight. Nothing about gold's outcome may be
       recorded against Bitcoin — not a success, and not a failure either. */
    releases[0]?.();
    await h.flush();

    expect(sup.status()[0]?.attempts).toBe(0);
    expect(sup.status()[0]?.state).toBe("pending");
    sup.stop();
  });
});

describe("a tab nobody is looking at", () => {
  it("stops asking while hidden and asks again the moment it is poked", async () => {
    const h = harness();
    let shown = true;
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({
      lanes: [a],
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      visible: () => shown,
    });
    sup.watch("XAUUSD|1h");
    await h.advance(60_000);
    const before = a.calls;
    expect(before).toBeGreaterThan(1);

    shown = false;
    await h.advance(60 * 60_000);
    expect(a.calls).toBe(before);
    expect(h.pending()).toBe(0);

    shown = true;
    sup.poke();
    await h.flush();
    expect(a.calls).toBe(before + 1);
    sup.stop();
  });

  it("a poke ignores a backoff earned under different conditions", async () => {
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const sup = createSupervisor({ lanes: [a], now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    sup.watch("XAUUSD|1h");
    await h.advance(20 * 60_000);
    const before = a.calls;

    a.answers = true;
    sup.poke();
    await h.flush();
    expect(a.calls).toBe(before + 1);
    expect(stateOf(sup, "models")).toBe("fresh");
    sup.stop();
  });
});

describe("lanes that share one request", () => {
  it("issues it once per sweep, not once per lane", async () => {
    /* Derivatives and cross-venue both come out of `refreshDecision`. Asking
       three times for one answer is how a terminal earns a rate limit. */
    const h = harness();
    let calls = 0;
    const shared = async (): Promise<void> => {
      calls++;
    };
    const a = lane("derivatives", h, { refresh: shared, answeredAt: () => null });
    const b = lane("crossVenue", h, { refresh: shared, answeredAt: () => null });
    const sup = createSupervisor({
      lanes: [a, b],
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sup.watch("BTCUSDT|1h");
    await h.flush();
    expect(calls).toBe(1);
    sup.stop();
  });
});

describe("reporting", () => {
  it("fires only when the picture actually changes", async () => {
    const h = harness();
    const a = lane("models", h);
    a.answers = false;
    const onChange = vi.fn();
    const sup = createSupervisor({
      lanes: [a],
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      onChange,
    });
    sup.watch("XAUUSD|1h");
    await h.advance(30_000);
    const calls = onChange.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    /* Every subsequent failure changes the attempt count, so this cannot be
       zero — what it must not do is fire on sweeps where nothing moved. */
    expect(calls).toBeLessThan(12);
    sup.stop();
  });

  it("names what is missing and when it will be asked again", () => {
    const line = supervisorLine(
      [
        {
          id: "models",
          label: "Regime",
          state: "failed",
          attempts: 3,
          answeredAt: null,
          nextAttemptAt: 30_000,
          lastError: "connection refused",
        },
      ],
      12_000,
    );
    expect(line).toContain("Regime");
    expect(line).toContain("18s");
    expect(line).toContain("Retrying in");
    expect(line).toMatch(/^1 source is not answering/);
  });

  it("keeps saying it while the retry is in flight, so the line does not blink", () => {
    /* A message that disappears for two seconds every retry reads as a glitch,
       and this is the one line on the card that tells the operator what to do. */
    const line = supervisorLine(
      [
        {
          id: "models",
          label: "Regime",
          state: "pending",
          attempts: 2,
          answeredAt: null,
          nextAttemptAt: null,
          lastError: "connection refused",
        },
      ],
      12_000,
    );
    expect(line).toContain("Asking again now");
  });

  it("says nothing about a lane pending on its first attempt", () => {
    expect(
      supervisorLine(
        [
          {
            id: "models",
            label: "Regime",
            state: "pending",
            attempts: 0,
            answeredAt: null,
            nextAttemptAt: null,
            lastError: "",
          },
        ],
        2,
      ),
    ).toBe("");
  });

  it("says nothing when there is nothing to say", () => {
    expect(
      supervisorLine(
        [
          {
            id: "models",
            label: "Regime",
            state: "fresh",
            attempts: 0,
            answeredAt: 1,
            nextAttemptAt: null,
            lastError: "",
          },
        ],
        2,
      ),
    ).toBe("");
  });
});
