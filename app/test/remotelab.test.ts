/**
 * The lab client, and the promise that makes it safe to prefer.
 *
 * THE CONTRACT UNDER TEST IS "NEVER THROWS".
 * `ui/strategy.ts` calls this before falling back to running the study in the
 * tab. If any failure path could throw instead of returning `ok: false`, the
 * desk would stick on "Running…" with no verdict and no fallback — which is the
 * precise failure `scheduleFrame` was introduced to stop, reintroduced one
 * layer up. So every way a request can fail is enumerated here.
 *
 * The result itself is not re-tested: the worker runs the same `runStudy` the
 * fallback calls, and `backtest/lab.ts` has its own suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureBackend, resetBackend, useBackendStore } from "../src/data/backend";
import { labCapacity, runStudyRemote } from "../src/data/lab";
import { memoryRawStore } from "../src/store/kv";
import type { BarView } from "../src/chart/series";

const bars: BarView[] = Array.from({ length: 10 }, (_, i) => ({
  t: 1_700_000_000_000 + i * 3_600_000,
  o: 1,
  h: 2,
  l: 0.5,
  c: 1.5,
  v: 10,
}));

beforeEach(() => {
  useBackendStore(memoryRawStore());
  resetBackend(false);
  configureBackend({ base: "http://b.test" }, false);
});

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe("running a study on the backend", () => {
  it("returns the study the worker produced", async () => {
    const fetchImpl = jsonResponse({
      ok: true,
      ms: 412,
      study: { headline: { standing: "survived", verdict: "Survived", why: "" } },
    });
    const result = await runStudyRemote("ema", bars, {}, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.ms).toBe(412);
    expect(result.study?.headline.standing).toBe("survived");
  });

  it("posts the bars and the cost model to the configured gateway", async () => {
    const fetchImpl = jsonResponse({ ok: true, ms: 1, study: { headline: {} } });
    await runStudyRemote(
      "confluence",
      bars,
      { costs: { spread: 0.0002, commission: 0.0004, slippage: 0.0001, carryPerNight: 0.0001 }, coverage: 0.99 },
      fetchImpl,
    );

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://b.test/api/lab/study");
    const sent = JSON.parse(String(init.body));
    expect(sent.family).toBe("confluence");
    expect(sent.bars).toHaveLength(10);
    // The desk measured coverage against the venue calendar; the server cannot
    // repeat that, so it must travel with the request.
    expect(sent.opts.coverage).toBe(0.99);
    expect(sent.opts.costs.spread).toBe(0.0002);
  });

  it("sends bars as plain objects, so both engines read the same shape", async () => {
    const fetchImpl = jsonResponse({ ok: true, ms: 1, study: { headline: {} } });
    await runStudyRemote("ema", bars, {}, fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).bars[0]).toEqual({
      t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10,
    });
  });

  it("does not call the backend at all with no bars", async () => {
    const fetchImpl = jsonResponse({ ok: true });
    const result = await runStudyRemote("ema", [], {}, fetchImpl);
    expect(result.ok).toBe(false);
    // The engine would refuse this anyway; shipping the request to be told so
    // is a round trip for a known answer.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("every failure returns, rather than throwing", () => {
  it("a refused connection", async () => {
    const dead = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await runStudyRemote("ema", bars, {}, dead);
    expect(result.ok).toBe(false);
    expect(result.study).toBeNull();
    expect(result.error).toContain("Failed to fetch");
  });

  it("a 500 from the gateway", async () => {
    const result = await runStudyRemote("ema", bars, {}, jsonResponse({}, false, 500));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("a study the worker refused", async () => {
    const result = await runStudyRemote(
      "ema",
      bars,
      {},
      jsonResponse({ ok: false, error: "study exceeded 180s and was killed" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeded");
  });

  it("a body that will not parse", async () => {
    const bad = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    const result = await runStudyRemote("ema", bars, {}, bad);
    expect(result.ok).toBe(false);
  });

  it("an ok response carrying no study", async () => {
    const result = await runStudyRemote("ema", bars, {}, jsonResponse({ ok: true, ms: 5 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no study");
  });
});

describe("lab capacity", () => {
  it("reports the worker count when the backend can run studies", async () => {
    const result = await labCapacity(jsonResponse({ ok: true, workers: 8, cores: 8, hint: null }));
    expect(result).toMatchObject({ ok: true, workers: 8, cores: 8 });
  });

  it("names the missing piece when the gateway is up but the engine is not built", async () => {
    // The gateway answers health checks perfectly well in this state, which is
    // why "is the gateway up" is the wrong question for the desk to ask.
    const result = await labCapacity(
      jsonResponse({ ok: false, workers: 8, cores: 8, hint: "run: npm --prefix app run build:lab" }),
    );
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("build:lab");
  });

  it("says so plainly when there is no backend", async () => {
    const dead = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await labCapacity(dead)).toMatchObject({ ok: false, hint: "no backend" });
  });
});
