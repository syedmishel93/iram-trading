import { describe, it, expect } from "vitest";
import {
  createBucket,
  createGovernor,
  createSupervisor,
  binanceWeight,
  hostOf,
  HostBannedError,
  DEFAULT_POLICIES,
  type Clock,
  type HostPolicy,
} from "../src/core/kernel";

/**
 * A clock whose `sleep` advances virtual time instead of waiting.
 *
 * This is what makes the pump loop testable: it genuinely sleeps between
 * retries, so a real clock would make these tests take minutes, and a clock
 * that did NOT advance would spin forever. Advancing on sleep guarantees
 * progress and keeps the whole file under a second.
 */
function fakeClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance(ms) {
      t += ms;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const okResponse = (headers: Record<string, string> = {}, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    clone() {
      return this as unknown as Response;
    },
    json: async () => ({}),
  }) as unknown as Response;

const testPolicy = (over: Partial<HostPolicy> = {}): HostPolicy => ({
  host: "example.test",
  label: "test",
  capacity: 10,
  refillPerSec: 10,
  maxConcurrent: 4,
  defaultWeight: 1,
  jitterMs: 0,
  ...over,
});

describe("the token bucket", () => {
  it("starts full and refills at its rate", () => {
    const clock = fakeClock();
    const b = createBucket(10, 5, clock.now);
    expect(b.level()).toBe(10);
    b.spend(10);
    expect(b.level()).toBe(0);
    clock.advance(1000);
    expect(b.level()).toBeCloseTo(5, 6);
  });

  it("never refills past capacity", () => {
    const clock = fakeClock();
    const b = createBucket(10, 5, clock.now);
    clock.advance(1_000_000);
    expect(b.level()).toBe(10);
  });

  it("reports how long until a cost can be afforded", () => {
    const clock = fakeClock();
    const b = createBucket(10, 5, clock.now);
    b.spend(10);
    // 4 tokens at 5/s = 800ms.
    expect(b.waitFor(4)).toBe(800);
    expect(b.waitFor(0)).toBe(0);
  });

  it("does not wait forever for a cost larger than the whole bucket", () => {
    // Capacity 10, cost 50. Without the clamp this asks for a wait that can
    // never be satisfied and the request hangs rather than failing.
    const clock = fakeClock();
    const b = createBucket(10, 5, clock.now);
    b.spend(10);
    expect(b.waitFor(50)).toBe(2000);
  });

  it("halves the rate on penalty and drains the burst", () => {
    // A full bucket after a refusal would let the very next instant spend
    // everything the venue just said no to.
    const clock = fakeClock();
    const b = createBucket(10, 8, clock.now);
    expect(b.level()).toBe(10);
    b.penalise(0.5);
    expect(b.rate()).toBe(4);
    expect(b.level()).toBe(0);
  });

  it("recovers additively and never above the nominal rate", () => {
    const clock = fakeClock();
    const b = createBucket(10, 8, clock.now);
    b.penalise(0.5);
    for (let i = 0; i < 100; i++) b.recover(1);
    expect(b.rate()).toBe(8);
  });

  it("has a floor: repeated penalties cannot stop it entirely", () => {
    // A rate of zero is a permanent outage of our own making — the host would
    // never be probed again and the terminal would look broken forever.
    const clock = fakeClock();
    const b = createBucket(10, 8, clock.now);
    for (let i = 0; i < 50; i++) b.penalise(0.5);
    expect(b.rate()).toBeGreaterThan(0);
  });

  it("tightens on the venue's own counter but never loosens", () => {
    const clock = fakeClock();
    const b = createBucket(100, 10, clock.now);
    b.spend(50); // our estimate: 50 left
    b.syncUsed(900, 1000); // the venue says 10% left => 10 tokens
    expect(b.level()).toBeCloseTo(10, 6);

    // A header claiming plenty of room must not hand budget back: it may be
    // stale, or the IP may be shared with another client we cannot see.
    b.syncUsed(0, 1000);
    expect(b.level()).toBeCloseTo(10, 6);
  });

  it("ignores a nonsense header rather than acting on it", () => {
    const clock = fakeClock();
    const b = createBucket(100, 10, clock.now);
    b.spend(50);
    const before = b.level();
    b.syncUsed(NaN, 1000);
    b.syncUsed(10, 0);
    expect(b.level()).toBeCloseTo(before, 6);
  });
});

describe("endpoint weight", () => {
  it("charges the universe scan what it actually costs", () => {
    // /ticker/24hr with no symbol is weight 40. Treating it as 1 understates
    // the screener's opening request by 40x.
    expect(binanceWeight("https://api.binance.com/api/v3/ticker/24hr")).toBe(40);
    expect(binanceWeight("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")).toBe(2);
  });

  it("prices the common endpoints", () => {
    expect(binanceWeight("/api/v3/klines?symbol=BTCUSDT&interval=1h")).toBe(2);
    expect(binanceWeight("/api/v3/depth?symbol=BTCUSDT")).toBe(5);
    expect(binanceWeight("/api/v3/exchangeInfo")).toBe(20);
  });

  it("extracts a host without its port", () => {
    expect(hostOf("http://127.0.0.1:8787/ohlc")).toBe("127.0.0.1");
    expect(hostOf("https://api.binance.com/api/v3/klines")).toBe("api.binance.com");
  });
});

describe("the shipped policies", () => {
  it("sit under Binance's published ceiling, not at it", () => {
    // 1200 weight/minute is 20/s. Sustaining 8/s spends a third of the budget
    // and buys "never banned", which is the right trade for a terminal.
    const spot = DEFAULT_POLICIES.find((p) => p.host === "api.binance.com");
    expect(spot).toBeDefined();
    expect(spot!.refillPerSec).toBeLessThan(20);
    expect(spot!.weightLimit).toBe(1200);
    expect(spot!.usedWeightHeader).toBe("x-mbx-used-weight-1m");
  });
});

describe("the governor", () => {
  it("makes ONE request when two callers ask for the same URL at once", async () => {
    const clock = fakeClock();
    let calls = 0;
    const g = createGovernor({
      clock,
      policies: [testPolicy()],
      fetchImpl: async () => {
        calls++;
        return okResponse();
      },
    });

    const [a, b] = await Promise.all([
      g.request({ url: "http://example.test/x" }),
      g.request({ url: "http://example.test/x" }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(g.stats().totalShared).toBe(1);
  });

  /**
   * REGRESSION, found by a calendar test rather than reasoned about.
   *
   * The local passthrough at 127.0.0.1 fetches third-party URLs and returns
   * whatever they answer. When the calendar mirror answered 429, the governor
   * read it as "127.0.0.1 is rate-limiting us" and PARKED THE LOCAL PROXY, so
   * one upstream's limit took out every unrelated route through it.
   */
  describe("a relay's refusals belong to the upstream", () => {
    const relayGovernor = (status: number) => {
      const clock = fakeClock();
      const g = createGovernor({
        clock,
        policies: [testPolicy()],
        fetchImpl: async () =>
          new Response("<html>refused</html>", { status, headers: { "retry-after": "120" } }),
      });
      return { g, clock };
    };

    it("does not park a relay for an upstream 429", async () => {
      const { g } = relayGovernor(429);
      const res = await g.request({ url: "http://example.test/fetch?url=x", relay: true });
      expect(res.status).toBe(429);
      const host = g.stats().hosts[0];
      expect(host?.bannedUntil).toBe(0);
      expect(host?.rejections).toBe(0);
    });

    it("does not park a relay for an upstream 403 either", async () => {
      const { g } = relayGovernor(403);
      await g.request({ url: "http://example.test/fetch?url=x", relay: true });
      expect(g.stats().hosts[0]?.bannedUntil).toBe(0);
    });

    it("does not halve a relay's sustained rate", async () => {
      const { g } = relayGovernor(429);
      /* The host only exists once it has been used, so the baseline is read
         AFTER the first request rather than before it. */
      await g.request({ url: "http://example.test/fetch?url=x", relay: true });
      const before = g.stats().hosts[0]?.ratePerSec;
      expect(before).toBeGreaterThan(0);
      await g.request({ url: "http://example.test/fetch?url=y", relay: true });
      expect(g.stats().hosts[0]?.ratePerSec).toBe(before);
    });

    // Nothing is hidden: the caller still sees the refusal and decides.
    it("still returns the refusal to the caller", async () => {
      const { g } = relayGovernor(429);
      expect((await g.request({ url: "http://example.test/fetch?url=x", relay: true })).ok).toBe(false);
    });

    // The flag is opt-in and narrow. An ordinary host is still penalised.
    it("still parks an ordinary host for the same 429", async () => {
      const { g } = relayGovernor(429);
      await g.request({ url: "http://example.test/direct" });
      expect(g.stats().hosts[0]?.bannedUntil).toBeGreaterThan(0);
    });
  });

  it("does not share a POST", async () => {
    const clock = fakeClock();
    let calls = 0;
    const g = createGovernor({
      clock,
      policies: [testPolicy()],
      fetchImpl: async () => {
        calls++;
        return okResponse();
      },
    });
    await Promise.all([
      g.request({ url: "http://example.test/x", init: { method: "POST" } }),
      g.request({ url: "http://example.test/x", init: { method: "POST" } }),
    ]);
    expect(calls).toBe(2);
  });

  it("caps concurrency", async () => {
    const clock = fakeClock();
    let live = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const g = createGovernor({
      clock,
      policies: [testPolicy({ maxConcurrent: 2, capacity: 100, refillPerSec: 1000 })],
      fetchImpl: async () => {
        live++;
        peak = Math.max(peak, live);
        const d = deferred<void>();
        gates.push(() => d.resolve());
        await d.promise;
        live--;
        return okResponse();
      },
    });

    const all = Promise.all(
      Array.from({ length: 6 }, (_, i) => g.request({ url: `http://example.test/${i}` })),
    );
    // Let the queue settle, then release everything.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      gates.splice(0).forEach((fn) => fn());
    }
    await all;
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("serves an interactive request before a queued background one", async () => {
    const clock = fakeClock();
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const g = createGovernor({
      clock,
      policies: [testPolicy({ maxConcurrent: 1, capacity: 100, refillPerSec: 1000 })],
      fetchImpl: async (input) => {
        order.push(String(input));
        const d = deferred<void>();
        gates.push(() => d.resolve());
        await d.promise;
        return okResponse();
      },
    });

    const blocker = g.request({ url: "http://example.test/blocker" });
    await Promise.resolve();
    const bg = g.request({ url: "http://example.test/bg", priority: "background" });
    const ui = g.request({ url: "http://example.test/ui", priority: "interactive" });

    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      gates.splice(0).forEach((fn) => fn());
    }
    await Promise.all([blocker, bg, ui]);

    // The blocker went first because it arrived to an empty queue. Of the two
    // that queued behind it, the interactive one must win regardless of order.
    expect(order[0]).toContain("blocker");
    expect(order[1]).toContain("/ui");
  });

  it("parks the host on a 429 and honours Retry-After exactly", async () => {
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [testPolicy()],
      fetchImpl: async () => okResponse({ "retry-after": "30" }, 429),
    });

    await g.request({ url: "http://example.test/a" });
    expect(g.isParked("example.test")).toBe(true);

    // Probing before the window closes must be refused locally, not sent.
    await expect(g.request({ url: "http://example.test/b" })).rejects.toBeInstanceOf(
      HostBannedError,
    );

    clock.advance(30_001);
    expect(g.isParked("example.test")).toBe(false);
  });

  it("halves the sustained rate after a 429 rather than returning to it", async () => {
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [testPolicy({ refillPerSec: 10 })],
      fetchImpl: async () => okResponse({ "retry-after": "1" }, 429),
    });
    await g.request({ url: "http://example.test/a" });
    expect(g.stats().hosts[0]!.ratePerSec).toBe(5);
    expect(g.stats().hosts[0]!.nominalRatePerSec).toBe(10);
  });

  it("treats a 418 as a ban and parks for far longer than a 429", async () => {
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [testPolicy()],
      fetchImpl: async () => okResponse({}, 418),
    });
    await g.request({ url: "http://example.test/a" });
    const state = g.stats().hosts[0]!;
    expect(state.bannedUntil - clock.now()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(state.banReason).toMatch(/Probing extends this/);
  });

  it("tightens the budget from the venue's own used-weight header", async () => {
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [
        testPolicy({
          capacity: 100,
          usedWeightHeader: "x-mbx-used-weight-1m",
          weightLimit: 1000,
        }),
      ],
      fetchImpl: async () => okResponse({ "x-mbx-used-weight-1m": "950" }),
    });

    await g.request({ url: "http://example.test/a", weight: 1 });
    const state = g.stats().hosts[0]!;
    // The venue says 5% of the window remains, so at most 5% of the burst.
    expect(state.tokens).toBeLessThanOrEqual(5);
    expect(state.reportedUsed).toBe(950);
  });

  it("rejects a queued request whose caller aborted", async () => {
    const clock = fakeClock();
    const gates: Array<() => void> = [];
    const g = createGovernor({
      clock,
      policies: [testPolicy({ maxConcurrent: 1 })],
      fetchImpl: async () => {
        const d = deferred<void>();
        gates.push(() => d.resolve());
        await d.promise;
        return okResponse();
      },
    });

    const blocker = g.request({ url: "http://example.test/blocker" });
    await Promise.resolve();

    const ac = new AbortController();
    const queued = g.request({ url: "http://example.test/queued", signal: ac.signal });
    const assertion = expect(queued).rejects.toThrow(/abort/i);
    ac.abort();

    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      gates.splice(0).forEach((fn) => fn());
    }
    await assertion;
    await blocker;
  });

  it("counts requests and refusals for the desk to show", async () => {
    const clock = fakeClock();
    let n = 0;
    const g = createGovernor({
      clock,
      policies: [testPolicy()],
      fetchImpl: async () => okResponse({}, ++n === 1 ? 200 : 500),
    });
    await g.request({ url: "http://example.test/a" });
    await g.request({ url: "http://example.test/b" });
    expect(g.stats().totalRequests).toBe(2);
    expect(g.stats().hosts[0]!.host).toBe("example.test");
  });

  it("applies a conservative fallback policy to an unknown host", async () => {
    const clock = fakeClock();
    const g = createGovernor({ clock, policies: [], fetchImpl: async () => okResponse() });
    await g.request({ url: "https://who.knows/x" });
    const state = g.stats().hosts[0]!;
    expect(state.host).toBe("who.knows");
    expect(state.nominalRatePerSec).toBeLessThanOrEqual(2);
  });
});

describe("the supervisor", () => {
  it("never runs a job twice at once", async () => {
    const clock = fakeClock();
    const s = createSupervisor(clock);
    let live = 0;
    let peak = 0;
    let gate = deferred<void>();

    s.add({
      id: "slow",
      label: "slow",
      everyMs: 1,
      run: async () => {
        live++;
        peak = Math.max(peak, live);
        await gate.promise;
        live--;
      },
    });

    const first = s.runNow("slow");
    const second = s.runNow("slow"); // must be a no-op while the first runs
    gate.resolve();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    gate = deferred<void>();
  });

  it("isolates a failure and records it instead of losing it", async () => {
    const clock = fakeClock();
    const s = createSupervisor(clock);
    s.add({
      id: "bad",
      label: "bad",
      everyMs: 1000,
      run: async () => {
        throw new Error("target unreachable");
      },
    });
    await s.runNow("bad");
    const state = s.jobs()[0]!;
    expect(state.failures).toBe(1);
    expect(state.lastError).toBe("target unreachable");
  });

  it("backs off a repeatedly failing job instead of retrying forever", async () => {
    const clock = fakeClock();
    const s = createSupervisor(clock);
    s.add({
      id: "bad",
      label: "bad",
      everyMs: 1000,
      run: async () => {
        throw new Error("down");
      },
    });
    await s.runNow("bad");
    await s.runNow("bad");
    await s.runNow("bad");
    expect(s.jobs()[0]!.backoffLevel).toBe(3);
  });

  it("clears the backoff once the job succeeds again", async () => {
    const clock = fakeClock();
    const s = createSupervisor(clock);
    let fail = true;
    s.add({
      id: "flaky",
      label: "flaky",
      everyMs: 1000,
      run: async () => {
        if (fail) throw new Error("down");
      },
    });
    await s.runNow("flaky");
    expect(s.jobs()[0]!.backoffLevel).toBe(1);
    fail = false;
    await s.runNow("flaky");
    expect(s.jobs()[0]!.backoffLevel).toBe(0);
    expect(s.jobs()[0]!.lastError).toBeNull();
  });

  it("stops cleanly and reports that it is stopped", () => {
    const clock = fakeClock();
    const s = createSupervisor(clock);
    s.add({ id: "j", label: "j", everyMs: 1000, run: async () => undefined });
    s.start();
    expect(s.running()).toBe(true);
    s.stop();
    expect(s.running()).toBe(false);
    expect(s.jobs()[0]!.nextRun).toBeNull();
  });
});

describe("an unreadable usage header", () => {
  it("is reported rather than silently never syncing", async () => {
    // MEASURED: Binance sends no `Access-Control-Expose-Headers`, so a browser
    // cannot read `x-mbx-used-weight-1m` even though the server sends it. A
    // counter stuck at null would read as "zero used" in the desk, which is the
    // opposite of the truth. Say so instead.
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [
        testPolicy({ usedWeightHeader: "x-mbx-used-weight-1m", weightLimit: 1000 }),
      ],
      fetchImpl: async () => okResponse({}), // header absent, as through CORS
    });

    for (let i = 0; i < 4; i++) await g.request({ url: `http://example.test/${i}` });
    const state = g.stats().hosts[0]!;
    expect(state.headerBlocked).toBe(true);
    expect(state.reportedUsed).toBeNull();
  });

  it("is NOT reported when the header does arrive", async () => {
    const clock = fakeClock();
    const g = createGovernor({
      clock,
      policies: [
        testPolicy({ usedWeightHeader: "x-mbx-used-weight-1m", weightLimit: 1000 }),
      ],
      fetchImpl: async () => okResponse({ "x-mbx-used-weight-1m": "100" }),
    });
    for (let i = 0; i < 4; i++) await g.request({ url: `http://example.test/${i}` });
    expect(g.stats().hosts[0]!.headerBlocked).toBe(false);
  });

  it("does not flag a host that never claimed to publish one", async () => {
    const clock = fakeClock();
    const g = createGovernor({ clock, policies: [testPolicy()], fetchImpl: async () => okResponse() });
    await g.request({ url: "http://example.test/a" });
    expect(g.stats().hosts[0]!.headerBlocked).toBe(false);
  });
});
