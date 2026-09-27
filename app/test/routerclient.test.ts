/**
 * THE ROUTER CLIENT — three outcomes, and the one that must not look like an error.
 *
 * A report saying `skill: false` is a SUCCESS of this call and a failure of the
 * model. "The model learned nothing" is the most common honest answer a router
 * can give, and a client that folded it into an error would make the system
 * look broken every time it was being truthful. So `ok` / `refused` / `offline`
 * are three separate things here, exactly as `data/quant.ts` argues.
 *
 * THE URL IS ASSERTED FROM WHAT `fetch` WAS CALLED WITH, PARSED.
 * CLAUDE.md records a test that compared the bug to itself — the whole Quant
 * desk sent every request to the literal path `() => quantBase()/quant/health`
 * for months, and the one assertion that touched the address built its expected
 * value with the same broken interpolation, so it passed. An expected value
 * taken from the code under test cannot fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { trainRouter } from "../src/data/router";

const rows = [{ t: 1, outcome: "target", features: { rsi14: 50 } }];

const REPORT = {
  ok: true,
  why: "",
  rows: 400,
  scored: 300,
  auc: 0.61,
  accuracy: 0.58,
  baseRate: 0.52,
  lift: 0.06,
  skill: true,
  folds: 4,
  timeOrdered: true,
  foldSpans: [],
  calibration: [],
  suggestedThreshold: 0.6,
  thresholdBasis: "calibration",
  features: ["rsi14"],
};

const seen: string[] = [];

function stub(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    seen.push(url);
    void init;
    return impl();
  });
}

const res = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

describe("it posts to the route it means to", () => {
  it("calls /svc/router/train, asserted from the URL fetch received", async () => {
    stub(() => res(REPORT));
    await trainRouter(rows);
    expect(seen).toHaveLength(1);
    // Parsed, not string-matched against anything this module builds.
    const u = new URL(seen[0] as string);
    expect(u.pathname).toBe("/svc/router/train");
    expect(u.protocol.startsWith("http")).toBe(true);
  });
});

describe("the three outcomes stay three outcomes", () => {
  it("passes a fitted report through, skill and all", async () => {
    stub(() => res(REPORT));
    const r = await trainRouter(rows);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.report.skill).toBe(true);
    expect(r.report.auc).toBeCloseTo(0.61, 6);
  });

  it("treats a model that learned nothing as a RESULT, not a failure", async () => {
    const noSkill = { ...REPORT, skill: false, auc: 0.503, why: "no skill: AUC 0.503 against 0.500" };
    stub(() => res(noSkill));
    const r = await trainRouter(rows);
    // The call succeeded. The model did not. Those are different facts and the
    // desk has to be able to tell them apart.
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.report.skill).toBe(false);
    expect(r.report.why).toContain("no skill");
  });

  it("keeps a refusal's reason verbatim", async () => {
    stub(() => res({ ok: false, why: "120 decided rows is below the 200 this will fit on" }));
    const r = await trainRouter(rows);
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") return;
    expect(r.why).toContain("120 decided rows");
  });

  it("reports a dead service as offline, naming the address", async () => {
    stub(() => {
      throw new TypeError("Failed to fetch");
    });
    const r = await trainRouter(rows);
    expect(r.kind).toBe("offline");
    if (r.kind !== "offline") return;
    // Addressed to the operator: they can start the service. A TypeError is
    // addressed to nobody.
    expect(r.why).toContain("/svc/router/train");
    expect(r.why).not.toContain("TypeError");
  });

  it("reports an HTML body as offline rather than as a report", async () => {
    // The shape that had the news bar saying a running service was down: a
    // Flask 404 page arriving where JSON was expected.
    stub(
      () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        }) as unknown as Response,
    );
    const r = await trainRouter(rows);
    expect(r.kind).toBe("offline");
    if (r.kind !== "offline") return;
    expect(r.why).toContain("did not answer with a report");
  });

  it("reports a non-200 as offline with its status", async () => {
    stub(() => res({}, 500));
    const r = await trainRouter(rows);
    expect(r.kind).toBe("offline");
    if (r.kind !== "offline") return;
    expect(r.why).toContain("500");
  });
});
