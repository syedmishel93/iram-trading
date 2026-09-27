/**
 * The batch job client: submit, poll, cancel, and the driver over the three.
 *
 * WHAT IS UNDER TEST IS THE PROTOCOL AND THE REFUSALS, NOT THE STUDIES.
 * The worker runs this repository's own `runStudy`; `labspec.test.ts` and
 * `lab.test.ts` own the arithmetic. What lives here is the layer that can be
 * wrong without anything looking wrong: a URL with the id in the wrong place, a
 * 200 whose body is an error read as "0 of 0 done", a lost job reported as a
 * finished one. Every one of those renders as an empty result set, which reads
 * as "the sweep found nothing" rather than "the sweep never happened" — the
 * same class as `/svc/health` rendering "0 of 0 loops" in green.
 *
 * EVERY URL IS ASSERTED BY `new URL(url).pathname`, and every body by parsing
 * what `fetch` was actually called with. Nothing here compares a value against
 * an expression the code under test produced; `expect(reason).toContain(
 * QUANT_BASE)` passed for months on a URL that could never resolve.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureBackend, resetBackend, useBackendStore } from "../src/data/backend";
import {
  LAB_BATCH_MAX,
  cancelLabJob,
  pollLabJob,
  runLabJob,
  submitLabJob,
  type LabStudyRequest,
} from "../src/data/lab";
import { memoryRawStore } from "../src/store/kv";
import type { BarView } from "../src/chart/series";
import type { RuleSpec } from "../src/backtest/rules";

const bars: BarView[] = Array.from({ length: 4 }, (_, i) => ({
  t: 1_700_000_000_000 + i * 3_600_000,
  o: 1,
  h: 2,
  l: 0.5,
  c: 1.5,
  v: 10,
}));

const SPEC: RuleSpec = {
  id: "ema-9-21-cross",
  name: "EMA 9/21 cross",
  style: "scalp",
  long: [["ema9", "crossabove", "ema21"]],
  stop: { type: "atr", mult: 2 },
  target: { type: "rr", value: 2 },
};

const STUDIES: LabStudyRequest[] = [
  { subject: { kind: "family", id: "ema" }, bars, opts: { coverage: 0.99 } },
  { subject: { kind: "spec", id: SPEC.id, spec: SPEC }, symbol: "BTCUSDT", provider: "binance", timeframe: "4h", limit: 3000 },
];

beforeEach(() => {
  useBackendStore(memoryRawStore());
  resetBackend(false);
  configureBackend({ base: "http://b.test" }, false);
  vi.unstubAllGlobals();
});

/** What `fetch` was called with, as a URL and a parsed body. */
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const calls = (fn: unknown): Call[] =>
  (fn as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls.map(([url, init]) => ({
    path: new URL(url).pathname,
    method: init?.method ?? "GET",
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  }));

/** A fetch that answers each call from a queue, in order. */
const queue = (...bodies: { body: unknown; ok?: boolean; status?: number }[]) => {
  let i = 0;
  return vi.fn(async () => {
    const next = bodies[Math.min(i, bodies.length - 1)] as { body: unknown; ok?: boolean; status?: number };
    i += 1;
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  });
};

const HEALTHY = { body: { ok: true, workers: 8, cores: 8, hint: null } };
const submitted = (id: string, total: number) => ({ body: { id, total, state: "running" } });
const report = (over: Record<string, unknown> = {}) => ({
  body: { id: "j1", state: "done", done: 2, total: 2, elapsed_s: 3.5, studies: [], ...over },
});

describe("submitting a batch", () => {
  it("posts to /api/lab/studies with one entry per study", async () => {
    const fetchImpl = queue(submitted("abc123", 2));
    vi.stubGlobal("fetch", fetchImpl);

    const handle = await submitLabJob(STUDIES);
    expect(handle).toMatchObject({ ok: true, id: "abc123", total: 2, state: "running" });

    const [call] = calls(fetchImpl);
    expect(call?.path).toBe("/api/lab/studies");
    expect(call?.method).toBe("POST");
    const studies = (call?.body as { studies: Record<string, unknown>[] }).studies;
    expect(studies).toHaveLength(2);
  });

  it("sends a family study as `family` and a spec study as `spec` — never both", async () => {
    const fetchImpl = queue(submitted("abc123", 2));
    vi.stubGlobal("fetch", fetchImpl);
    await submitLabJob(STUDIES);

    const studies = (calls(fetchImpl)[0]?.body as { studies: Record<string, unknown>[] }).studies;
    const [family, spec] = studies as [Record<string, unknown>, Record<string, unknown>];

    expect(family["family"]).toBe("ema");
    expect("spec" in family).toBe(false);
    // The bars go as plain objects, the shape both engines read.
    expect((family["bars"] as unknown[])[0]).toEqual({
      t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10,
    });
    // The desk measured coverage against the venue calendar; the server cannot
    // repeat that, so it travels with the request.
    expect((family["opts"] as Record<string, unknown>)["coverage"]).toBe(0.99);

    expect("family" in spec).toBe(false);
    expect((spec["spec"] as RuleSpec).id).toBe("ema-9-21-cross");
    expect((spec["spec"] as RuleSpec).stop).toEqual({ type: "atr", mult: 2 });
    // A symbol study sends no bars at all — thirty bytes instead of a megabyte.
    expect("bars" in spec).toBe(false);
    expect(spec["symbol"]).toBe("BTCUSDT");
    expect(spec["provider"]).toBe("binance");
    expect(spec["timeframe"]).toBe("4h");
    expect(spec["limit"]).toBe(3000);
  });

  it("refuses more studies than the backend's own cap, without asking", async () => {
    const fetchImpl = queue(submitted("abc123", 65));
    vi.stubGlobal("fetch", fetchImpl);

    const many = Array.from({ length: LAB_BATCH_MAX + 1 }, () => STUDIES[0] as LabStudyRequest);
    const handle = await submitLabJob(many);
    expect(handle.ok).toBe(false);
    expect(handle.error).toContain("65");
    expect(handle.error).toContain("64");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty batch", async () => {
    const fetchImpl = queue(submitted("abc123", 0));
    vi.stubGlobal("fetch", fetchImpl);
    expect((await submitLabJob([])).error).toBe("No studies to run.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says plainly when there is no backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const handle = await submitLabJob(STUDIES);
    expect(handle.ok).toBe(false);
    expect(handle.error).toContain("not answering on this address");
    expect(handle.error).toContain("python run.py");
  });

  it("distinguishes a rejected shape from a dead backend", async () => {
    vi.stubGlobal("fetch", queue({ body: { detail: [] }, ok: false, status: 422 }));
    const handle = await submitLabJob(STUDIES);
    expect(handle.error).toContain("not a shape it accepts");
  });

  it("does not report a job that has no id", async () => {
    vi.stubGlobal("fetch", queue({ body: { total: 2, state: "running" } }));
    expect((await submitLabJob(STUDIES)).error).toContain("no job id");
  });
});

describe("polling a job", () => {
  it("asks for the id in the path, and maps every outcome", async () => {
    const fetchImpl = queue(
      report({
        state: "running",
        done: 1,
        studies: [
          {
            label: "BTCUSDT/1h/spec:ema-9-21-cross",
            subject: "spec:ema-9-21-cross",
            ok: true,
            error: null,
            ms: 412,
            bars: 2000,
            source: "client",
            headline: { standing: "survived" },
            study: { headline: { standing: "survived", verdict: "Survived", why: "" } },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const progress = await pollLabJob("j1");
    expect(calls(fetchImpl)[0]?.path).toBe("/api/lab/studies/j1");
    expect(progress).toMatchObject({ ok: true, state: "running", done: 1, total: 2, elapsedS: 3.5 });
    expect(progress.studies[0]).toMatchObject({
      subject: "spec:ema-9-21-cross",
      ok: true,
      ms: 412,
      bars: 2000,
      source: "client",
      error: "",
    });
    expect(progress.studies[0]?.study?.headline.standing).toBe("survived");
  });

  it("escapes the id rather than building a second path segment out of it", async () => {
    const fetchImpl = queue(report());
    vi.stubGlobal("fetch", fetchImpl);
    await pollLabJob("a/b");
    expect(calls(fetchImpl)[0]?.path).toBe("/api/lab/studies/a%2Fb");
  });

  it("reads a 200 whose body is an error as an error", async () => {
    // The route answers 200 with {"error": "no job ..."} for an id it has lost.
    // Read as a report it is "0 of 0 done", which renders as finished.
    vi.stubGlobal("fetch", queue({ body: { error: "no job j1" } }));
    const progress = await pollLabJob("j1");
    expect(progress.ok).toBe(false);
    expect(progress.state).toBe("unknown");
    expect(progress.error).toContain("no job j1");
    expect(progress.error).toContain("submitted again");
  });

  it("keeps `failed: TypeError: ...` out of the state, and in the reason", async () => {
    vi.stubGlobal("fetch", queue(report({ state: "failed: TypeError: nope" })));
    expect((await pollLabJob("j1")).state).toBe("failed");
  });

  it("says plainly when there is no backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect((await pollLabJob("j1")).error).toContain("not answering on this address");
  });
});

describe("cancelling a job", () => {
  it("DELETEs the job's own path", async () => {
    const fetchImpl = queue({ body: { cancelled: true } });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await cancelLabJob("j1");
    expect(calls(fetchImpl)[0]).toMatchObject({ path: "/api/lab/studies/j1", method: "DELETE" });
    expect(result).toEqual({ ok: true, cancelled: true, error: "" });
  });

  it("reports `cancelled: false` as a fact, not as a failure", async () => {
    // A job that had already finished. Not the same as "the request failed",
    // and a caller that cannot tell them apart will retry for ever.
    vi.stubGlobal("fetch", queue({ body: { cancelled: false } }));
    expect(await cancelLabJob("j1")).toEqual({ ok: true, cancelled: false, error: "" });
  });

  it("says plainly when there is no backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await cancelLabJob("j1")).toMatchObject({ ok: false, cancelled: false });
  });
});

describe("the driver", () => {
  const noWait = async (): Promise<void> => {};

  it("checks capacity, submits, polls to done, and reports progress as studies land", async () => {
    const fetchImpl = queue(
      HEALTHY,
      submitted("j1", 2),
      report({ state: "running", done: 1, studies: [{ label: "a", subject: "family:ema", ok: true, ms: 1 }] }),
      report({
        state: "done",
        done: 2,
        studies: [
          { label: "a", subject: "family:ema", ok: true, ms: 1 },
          { label: "b", subject: "spec:x", ok: true, ms: 2 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const seen: number[] = [];
    const final = await runLabJob(STUDIES, { wait: noWait, onProgress: (p) => seen.push(p.done) });

    expect(seen).toEqual([1, 2]);
    expect(final).toMatchObject({ ok: true, state: "done", done: 2, total: 2 });
    expect(final.studies).toHaveLength(2);
    expect(calls(fetchImpl).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/lab/health",
      "POST /api/lab/studies",
      "GET /api/lab/studies/j1",
      "GET /api/lab/studies/j1",
    ]);
  });

  it("names a missing engine before it sends a single study", async () => {
    // The gateway accepts a batch perfectly happily with the engine unbuilt and
    // then answers with n identical worker errors. One sentence beats n.
    const fetchImpl = queue({
      body: { ok: false, workers: 8, cores: 8, hint: "run: npm --prefix app run build:lab   (and install Node)" },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const final = await runLabJob(STUDIES, { wait: noWait });
    expect(final.ok).toBe(false);
    expect(final.error).toContain("cannot study anything");
    expect(final.error).toContain("build:lab");
    expect(calls(fetchImpl).map((c) => c.path)).toEqual(["/api/lab/health"]);
  });

  it("names a dead backend differently from a backend that cannot study", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const final = await runLabJob(STUDIES, { wait: noWait });
    expect(final.error).toContain("not answering on this address");
    expect(final.error).not.toContain("build:lab");
  });

  it("stops on a lost job rather than waiting out the timeout on nothing", async () => {
    const fetchImpl = queue(HEALTHY, submitted("j1", 2), { body: { error: "no job j1" } });
    vi.stubGlobal("fetch", fetchImpl);
    const final = await runLabJob(STUDIES, { wait: noWait });
    expect(final.ok).toBe(false);
    expect(final.error).toContain("no job j1");
    expect(final.total).toBe(2);
  });

  it("gives up after the timeout, cancels, and keeps what did finish", async () => {
    let n = 0;
    const slow = vi.fn(async (url: string, init?: RequestInit) => {
      n += 1;
      // A real elapsed millisecond, so the deadline is crossed by time passing
      // rather than by a number chosen to make the branch fire.
      await new Promise((r) => setTimeout(r, 12));
      if (n === 1) return { ok: true, status: 200, json: async () => HEALTHY.body };
      if (n === 2) return { ok: true, status: 200, json: async () => submitted("j1", 2).body };
      if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ cancelled: true }) };
      return {
        ok: true,
        status: 200,
        json: async () => report({
          state: "running",
          done: 1,
          studies: [{ label: "a", subject: "family:ema", ok: true, ms: 1 }],
        }).body,
      };
    });
    vi.stubGlobal("fetch", slow);

    const final = await runLabJob(STUDIES, { wait: noWait, timeoutMs: 1 });
    expect(final.ok).toBe(false);
    expect(final.state).toBe("failed");
    expect(final.error).toContain("still running");
    expect(final.error).toContain("1 of 2");
    // The partial results are kept: they cost minutes of compute and the
    // caller can read them.
    expect(final.studies).toHaveLength(1);
    expect(calls(slow).some((c) => c.method === "DELETE")).toBe(true);
  });

  it("cancels on the signal, and says it was cancelled rather than that it failed", async () => {
    const controller = new AbortController();
    const fetchImpl = queue(
      HEALTHY,
      submitted("j1", 2),
      report({ state: "running", done: 1, studies: [{ label: "a", subject: "family:ema", ok: true, ms: 1 }] }),
      { body: { cancelled: true } },
    );
    vi.stubGlobal("fetch", fetchImpl);

    const final = await runLabJob(STUDIES, {
      wait: noWait,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(final.state).toBe("cancelled");
    expect(final.error).toBe("The sweep was cancelled.");
    expect(final.studies).toHaveLength(1);
    expect(calls(fetchImpl).some((c) => c.method === "DELETE")).toBe(true);
  });

  it("does not submit anything on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = queue(HEALTHY);
    vi.stubGlobal("fetch", fetchImpl);
    const final = await runLabJob(STUDIES, { wait: noWait, signal: controller.signal });
    expect(final.state).toBe("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
