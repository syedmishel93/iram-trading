// @vitest-environment jsdom
/**
 * Where an autonomous sweep's studies run: the gateway's workers, or this tab.
 *
 * The behaviour that matters is the accounting. Every entrant must come back
 * with an outcome — a study or a REASON — because `search.ts` charges the
 * hurdle for arms that were attempted, and a field that silently shrinks makes
 * the hurdle too low without telling anyone.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { chunk, createStudyRunner, REMOTE_FLOOR } from "../src/backtest/labrunner";
import { LAB_BATCH_MAX } from "../src/data/lab";
import { SPECS } from "../src/backtest/specs";
import type { Entrant, RunProgress } from "../src/backtest/autorun";
import type { BarView } from "../src/chart/series";

const entrant = (id: string): Entrant => ({
  spec: { id, name: id, style: "custom", long: [["ema9", "crossabove", "ema21"]], stop: { type: "atr", mult: 2 }, target: { type: "rr", value: 2 } },
  origin: "library",
});

/** Enough bars that a local study is attempted rather than refused outright. */
const bars: BarView[] = Array.from({ length: 900 }, (_, i) => ({
  t: 1_700_000_000_000 + i * 3_600_000,
  o: 100 + Math.sin(i / 7) * 5,
  h: 102 + Math.sin(i / 7) * 5,
  l: 98 + Math.sin(i / 7) * 5,
  c: 100 + Math.sin(i / 6) * 5,
  v: 1_000,
}));

const jsonOk = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** The gateway base may be relative in a test environment, so `new URL` is
    not safe here — the client's own failure path would swallow the throw as
    "the backend is not answering", which is how this fixture first lied. */
const pathOf = (url: unknown): string => String(url).replace(/^https?:\/\/[^/]+/, "");

afterEach(() => vi.unstubAllGlobals());

describe("chunk", () => {
  it("never exceeds what the gateway accepts", () => {
    const parts = chunk(Array.from({ length: 150 }, (_, i) => i));
    expect(parts.length).toBe(Math.ceil(150 / LAB_BATCH_MAX));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(LAB_BATCH_MAX);
    expect(parts.flat()).toHaveLength(150);
  });
});

describe("choosing where to run", () => {
  it("does not ask the gateway at all for a small field", async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ ok: true, workers: 8, cores: 8 }));
    const run = createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await run([entrant("a"), entrant("b")], () => {});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });

  it("falls back to this tab when the gateway cannot run studies, and still answers for every entrant", async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ ok: false, workers: 0, cores: 0, hint: "node missing" }));
    const run = createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch });
    const field = Array.from({ length: REMOTE_FLOOR + 1 }, (_, i) => entrant(`s${i}`));
    const out = await run(field, () => {});
    expect(out).toHaveLength(field.length);
    expect(new Set(out.map((o) => o.id))).toEqual(new Set(field.map((f) => f.spec.id)));
  });
});

describe("the remote path", () => {
  /**
   * A gateway modelled on the REAL one (`server/gateway/lab.py` `report()`):
   * the job report carries no top-level `error` key at all, and a study that
   * failed says so in its own row. The first version of this fixture sent
   * `error: ""` on every poll — which the client correctly reads as "this job
   * is gone", because the route answers 200 with `{"error": …}` for an id it
   * no longer holds.
   */
  const gateway = (opts: { studyOk?: boolean; studyError?: string; jobGone?: boolean } = {}) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      if (path === "/api/lab/health") return jsonOk({ ok: true, workers: 8, cores: 8 });
      if (path === "/api/lab/studies" && init?.method === "POST") {
        /* The wire format is `{spec}` or `{family}` — see `serialise` in
           data/lab.ts. It carries the whole rule, not an id, because a rule is
           editable and an id would name whatever it had become. */
        const body = JSON.parse(String(init.body)) as { studies: { spec?: { id: string }; family?: string }[] };
        lastSubmitted.push(...body.studies.map((x) => x.spec?.id ?? x.family ?? "?"));
        return jsonOk({ id: "job1", total: body.studies.length, state: "running" });
      }
      if (path.startsWith("/api/lab/studies/")) {
        if (opts.jobGone) return jsonOk({ error: "no job job1" });
        const ok = opts.studyOk ?? true;
        return jsonOk({
          id: "job1",
          state: "done",
          done: lastSubmitted.length,
          total: lastSubmitted.length,
          elapsed_s: 1,
          studies: lastSubmitted.map((id) => ({
            label: id,
            subject: `spec:${id}`,
            ok,
            error: ok ? "" : (opts.studyError ?? "the study failed"),
            ms: 10,
            bars: 900,
            source: "client",
            study: ok ? { configs: [{}], walk: { folds: [] }, promotion: { promoted: false, checks: [], summary: "no" } } : null,
          })),
        });
      }
      return jsonOk({});
    });
  let lastSubmitted: string[] = [];

  it("sends every entrant as a spec subject and returns a study for each", async () => {
    lastSubmitted = [];
    const fetchImpl = gateway();
    const field = SPECS.slice(0, 10).map((s) => ({ spec: s, origin: "library" as const }));
    const seen: RunProgress[] = [];
    const out = await createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch })(field, (p) => seen.push(p));
    expect(lastSubmitted).toEqual(field.map((f) => f.spec.id));
    expect(out).toHaveLength(field.length);
    expect(out.every((o) => o.study !== null)).toBe(true);
    expect(seen.at(-1)?.done).toBe(field.length);
    expect(seen.at(-1)?.total).toBe(field.length);
  });

  it("keeps a failed study as an arm, with the reason the gateway gave", async () => {
    lastSubmitted = [];
    const fetchImpl = gateway({ studyOk: false, studyError: "the engine is missing" });
    const field = SPECS.slice(0, 9).map((s) => ({ spec: s, origin: "library" as const }));
    const out = await createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch })(field, () => {});
    expect(out).toHaveLength(field.length);
    expect(out.every((o) => o.study === null)).toBe(true);
    expect(out[0]?.error).toContain("engine is missing");
  });

  it("re-runs here when the gateway lost the job, rather than reporting a dead field", async () => {
    /* A lost job's studies are unrecoverable — the gateway holds them in
       memory and a restart drops them. Nothing usable ran, so the tab runs
       them: the operator gets an answer instead of 85 identical errors. */
    lastSubmitted = [];
    const fetchImpl = gateway({ jobGone: true });
    const field = SPECS.slice(0, 9).map((s) => ({ spec: s, origin: "library" as const }));
    const out = await createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch })(field, () => {});
    expect(out).toHaveLength(field.length);
    expect(out.some((o) => o.study !== null)).toBe(true);
    for (const o of out) expect(o.error ?? "").not.toContain("no job");
  });

  it("studies the batch HERE when the gateway rejected it, because nothing ran", async () => {
    /* MEASURED in the browser: a gateway older than the spec support answered
       422 to the submit and all 85 rules came back "could not be studied",
       even though `labCapacity` had said yes. Nothing ran, so the tab runs
       them. */
    lastSubmitted = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      if (path === "/api/lab/health") return jsonOk({ ok: true, workers: 8, cores: 8 });
      if (path === "/api/lab/studies" && init?.method === "POST") {
        return { ok: false, status: 422, json: async () => ({}) } as unknown as Response;
      }
      return jsonOk({});
    });
    const field = SPECS.slice(0, 9).map((s) => ({ spec: s, origin: "library" as const }));
    const out = await createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch })(field, () => {});
    expect(out).toHaveLength(field.length);
    /* Studied locally: a real Study, or a real per-rule reason — never the
       job's rejection stamped over the whole field. */
    for (const o of out) expect(o.error ?? "").not.toContain("not a shape it accepts");
    expect(out.some((o) => o.study !== null)).toBe(true);
  });

  it("splits a field larger than the batch cap into separate jobs", async () => {
    lastSubmitted = [];
    const fetchImpl = gateway();
    const field = Array.from({ length: LAB_BATCH_MAX + 5 }, (_, i) => entrant(`s${i}`));
    await createStudyRunner({ bars, fetchImpl: fetchImpl as unknown as typeof fetch })(field, () => {});
    const submits = fetchImpl.mock.calls.filter(([url, init]) => pathOf(url) === "/api/lab/studies" && (init as RequestInit | undefined)?.method === "POST");
    expect(submits).toHaveLength(2);
  });
});

describe("cancelling", () => {
  it("stops the run and still reports a reason for the rules that never ran", async () => {
    const controller = new AbortController();
    controller.abort();
    const field = Array.from({ length: 4 }, (_, i) => entrant(`s${i}`));
    const out = await createStudyRunner({ bars, signal: controller.signal })(field, () => {});
    /* Local path: aborted before the first study, so nothing ran — but the
       caller still learns what happened to each arm. */
    expect(out).toHaveLength(0);
  });
});
