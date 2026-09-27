import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BARS,
  quant,
  quantHealth,
  quantLine,
  quantSlot,
  trimBars,
  quantUrl,
} from "../src/data/quant";
import type { BarView } from "../src/chart/series";

const bars = (n: number): BarView[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + i * 3_600_000,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 5,
  }));

/** Stand in for `fetch` with a scripted response. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(impl as unknown as typeof fetch));
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trimBars", () => {
  /**
   * A GARCH walk-forward over 20,000 bars takes minutes and answers a question
   * about 2019. The cap is about the answer, not only the speed.
   */
  it("keeps the NEWEST bars when it trims, not the oldest", () => {
    const all = bars(MAX_BARS + 500);
    const cut = trimBars(all);
    expect(cut).toHaveLength(MAX_BARS);
    expect(cut[cut.length - 1]?.t).toBe(all[all.length - 1]?.t);
    expect(cut[0]?.t).toBe(all[500]?.t);
  });

  it("leaves a short series alone, and copies it rather than aliasing", () => {
    const all = bars(10);
    const cut = trimBars(all);
    expect(cut).toEqual(all);
    expect(cut).not.toBe(all);
  });
});

/**
 * THE ADDRESS ITSELF, WHICH NOTHING USED TO ASSERT.
 *
 * `QUANT_BASE` was `(): string => quantBase()` and every call site read
 * `fetch(`${QUANT_BASE}${path}`)`. A template literal stringifies a FUNCTION BY
 * ITS SOURCE, so the real request went to `() => quantBase()/quant/health` and
 * the gateway answered 404 — the whole Quant desk reported "the quant service
 * is not running" against a healthy service, and nothing in 3,151 tests failed.
 *
 * `tsc` cannot see it (interpolating a function is legal), and the one test
 * that touched the address compared the broken string to itself. What catches
 * it is the assertion below: the URL handed to `fetch`.
 */
describe("the URL requests are actually sent to", () => {
  it("builds an absolute http address, with no function source in it", () => {
    const url = quantUrl("/quant/health");
    expect(url).toMatch(/^https?:\/\//);
    expect(url.endsWith("/quant/health")).toBe(true);
    /* The exact shape of the defect: `=>` or `()` anywhere in a URL means an
       expression was interpolated instead of its value. */
    expect(url).not.toMatch(/=>/);
    expect(url).not.toMatch(/\(\)/);
    /* And it must parse. `new URL` on the broken value threw nothing — it
       resolved as a relative path — so the parse alone is not enough; the
       pathname has to be the endpoint and nothing else. */
    expect(new URL(url).pathname).toBe("/quant/health");
  });

  it("sends the health check to that address and no other", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(String(url));
      return json({ ok: true, present: {}, missing: {}, degraded: [] });
    });
    const r = await quantHealth();
    expect(r.state).toBe("ok");
    expect(seen).toHaveLength(1);
    /* Parsed, not compared to `quantUrl(...)`. Asserting the call against the
       same helper that built it is the self-comparison that let the defect
       through: with the bug in place, `toEqual([quantUrl(path)])` PASSED. */
    expect(new URL(String(seen[0])).pathname).toBe("/quant/health");
    expect(String(seen[0])).not.toMatch(/=>/);
  });

  it("sends a POST to the endpoint's own path, not to a stringified closure", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(String(url));
      return json({ ok: true });
    });
    await quant.structure(bars(200));
    expect(seen).toHaveLength(1);
    expect(new URL(String(seen[0])).pathname).toBe("/quant/stats/structure");
  });
});

describe("the three outcomes", () => {
  /**
   * THE DISTINCTION THIS WHOLE MODULE IS BUILT AROUND.
   *
   * "Ninety bars is not enough to fit a GARCH model" is an ANSWER. "The
   * service is not running" is the absence of one. Collapsing them would let a
   * real finding render as a connection problem — which is exactly why the
   * service returns refusals at HTTP 200.
   */
  it("reads a refusal as a refusal, not as an outage", async () => {
    stubFetch(() => json({ ok: false, reason: "99 returns. A GARCH fit needs at least 250." }));
    const r = await quant.volatility(bars(100));
    expect(r.state).toBe("refused");
    if (r.state === "refused") expect(r.reason).toMatch(/at least 250/);
  });

  it("reads an unreachable service as offline, and names the fix", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const r = await quant.structure(bars(200));
    expect(r.state).toBe("offline");
    if (r.state === "offline") {
      /* The ADDRESS, not the expression that produces it. This line used to
         read `toContain(QUANT_BASE)` where `QUANT_BASE` was a function, so
         both sides of the comparison were the same stringified function source
         and the assertion passed on a URL that could never resolve. An expected
         value taken from the code under test cannot fail. */
      expect(r.reason).toContain("127.0.0.1");
      expect(r.reason).not.toMatch(/=>/);
      expect(r.reason).toMatch(/python run\.py/);
    }
  });

  it("reads a 5xx as offline rather than as a refusal", async () => {
    stubFetch(() => json({ ok: false, reason: "ignored" }, 500));
    const r = await quant.structure(bars(200));
    expect(r.state).toBe("offline");
  });

  it("passes a successful body through with its timing", async () => {
    stubFetch(() => json({ ok: true, call: "unit-root", ms: 240 }));
    const r = await quant.structure(bars(200));
    expect(r.state).toBe("ok");
    if (r.state === "ok") {
      expect(r.ms).toBe(240);
      expect((r.value as { call: string }).call).toBe("unit-root");
    }
  });

  /* An `ok` flag that is simply absent must not be read as a refusal: the
     service omits it on some paths and `setdefault` fills it server-side. */
  it("treats a body with no ok flag as a result", async () => {
    stubFetch(() => json({ call: "stationary" }));
    expect((await quant.structure(bars(200))).state).toBe("ok");
  });

  it("still refuses cleanly when the service gives no reason", async () => {
    stubFetch(() => json({ ok: false }));
    const r = await quant.structure(bars(200));
    expect(r.state).toBe("refused");
    if (r.state === "refused") expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("request shape", () => {
  it("trims the bars it sends rather than posting the whole archive", async () => {
    let sent: { bars: unknown[] } | null = null;
    stubFetch((_u, init) => {
      sent = JSON.parse(String(init?.body)) as { bars: unknown[] };
      return json({ ok: true });
    });
    await quant.volatility(bars(MAX_BARS + 1000), 4);
    expect(sent).not.toBeNull();
    expect((sent as unknown as { bars: unknown[] }).bars).toHaveLength(MAX_BARS);
  });

  it("sends the horizon and barrier the caller asked for", async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((_u, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ ok: true });
    });
    await quant.classify(bars(500), 12, 2.5);
    expect(sent["horizon"]).toBe(12);
    expect(sent["barrier_atr"]).toBe(2.5);
  });

  it("posts trade returns untouched, because their ORDER is the data", async () => {
    let sent: { returns: number[] } = { returns: [] };
    stubFetch((_u, init) => {
      sent = JSON.parse(String(init?.body)) as { returns: number[] };
      return json({ ok: true });
    });
    /* The HAC correction is about serial dependence. A client that sorted or
       deduplicated these would silently get the naive answer back. */
    const rs = [1.2, -1, -1, 0.4, 2.2, -1];
    await quant.edge(rs);
    expect(sent.returns).toEqual(rs);
  });
});

describe("quantHealth", () => {
  it("reports the libraries the service has", async () => {
    stubFetch(() => json({ ok: true, python: "3.14.4", present: { arch: "8.0.0" }, missing: {} }));
    const r = await quantHealth();
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.value.present["arch"]).toBe("8.0.0");
  });

  it("says how to start the service when it is not there", async () => {
    stubFetch(() => Promise.reject(new TypeError("nope")));
    const r = await quantHealth();
    expect(r.state).toBe("offline");
    if (r.state === "offline") expect(r.reason).toMatch(/python run\.py/);
  });
});

describe("quantSlot", () => {
  it("holds the result and clears the busy flag", async () => {
    const slot = quantSlot<{ v: number }>();
    expect(slot.busy()).toBe(false);
    expect(slot.result()).toBeNull();

    let release: (r: { state: "ok"; value: { v: number }; ms: number }) => void = () => {};
    const pending = new Promise<{ state: "ok"; value: { v: number }; ms: number }>((res) => {
      release = res;
    });
    slot.run(() => pending);
    expect(slot.busy()).toBe(true);

    release({ state: "ok", value: { v: 1 }, ms: 5 });
    await pending;
    /* Two ticks, not one: the chain is then → catch → finally, and each link
       costs a microtask whether or not it does anything. */
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.busy()).toBe(false);
    expect(slot.result()?.state).toBe("ok");
  });

  it("turns a rejection into a refusal instead of losing it", async () => {
    /* WITHOUT THE CATCH THIS WAS THE WORST STATE IN THE DESK.

       Every `fn` is an async closure and several do real work before the
       fetch — awaiting driver loads, building a panel, diagnosing it. A throw
       in any of that skipped the result, cleared `busy`, and surfaced only as
       an unhandled rejection in the console. The panel went back to reading
       "Not run yet." after a click that had run and failed: the one state an
       operator cannot recover from is the one identical to never having
       tried. */
    const slot = quantSlot<{ v: number }>();
    slot.run(() => Promise.reject(new Error("Every one of the 800 rows was dropped.")));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.busy()).toBe(false);
    expect(slot.result()?.state).toBe("refused");
    expect(slot.result()).toMatchObject({ reason: "Every one of the 800 rows was dropped." });
  });

  /**
   * Two overlapping GARCH fits race, and without a guard the SLOWER one wins —
   * so the panel ends up showing the answer to the older question.
   */
  it("ignores a second run while the first is still in flight", async () => {
    const slot = quantSlot<number>();
    const calls: number[] = [];
    const never = new Promise<never>(() => {});
    slot.run(() => {
      calls.push(1);
      return never;
    });
    slot.run(() => {
      calls.push(2);
      return never;
    });
    expect(calls).toEqual([1]);
  });

  it("clears back to nothing run yet", async () => {
    const slot = quantSlot<number>();
    slot.run(() => Promise.resolve({ state: "refused" as const, reason: "no" }));
    await Promise.resolve();
    await Promise.resolve();
    slot.clear();
    expect(slot.result()).toBeNull();
  });
});

describe("quantLine", () => {
  it("warns that a run takes time, so a slow panel does not read as hung", () => {
    expect(quantLine(null, true)).toMatch(/minute/);
  });

  it("says nothing has run yet rather than showing a blank", () => {
    expect(quantLine(null, false)).toBe("Not run yet.");
  });

  /* A refusal's reason is shown VERBATIM. Summarising it here would defeat the
     point of the service writing a specific one. */
  it("shows a refusal's own words", () => {
    expect(quantLine({ state: "refused", reason: "99 returns; 250 is the floor." }, false)).toBe(
      "99 returns; 250 is the floor.",
    );
  });

  it("shows an outage's own words too", () => {
    expect(quantLine({ state: "offline", reason: "Not running." }, false)).toBe("Not running.");
  });

  it("reports how long a successful run took", () => {
    expect(quantLine({ state: "ok", value: 1, ms: 7600 }, false)).toBe("Answered in 7.6s.");
  });
});
