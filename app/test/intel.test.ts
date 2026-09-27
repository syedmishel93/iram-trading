import { describe, it, expect, vi, afterEach } from "vitest";
import { createIntel, forecastStanding, type ForecastRead } from "../src/data/intel";
import type { BarView } from "../src/chart/series";

const bars = (n: number): BarView[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * 3_600_000,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100.5 + i,
    v: 10,
  }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const forecast = (over: Partial<ForecastRead>): ForecastRead => ({
  ok: true,
  pUp: 0.62,
  accuracy: 0.58,
  brier: 0.22,
  n: 4000,
  horizon: 24,
  ...over,
});

describe("what a forecast is allowed to claim", () => {
  it("rejects an uncalibrated model however confident it looks", () => {
    // 0.25 is the Brier score of always saying 50%. At or above it, the
    // probability is worse than admitting ignorance — and a confident-looking
    // 72% from an uncalibrated model is the single most dangerous number here.
    const s = forecastStanding(forecast({ pUp: 0.72, brier: 0.26 }));
    expect(s.usable).toBe(false);
    expect(s.why).toMatch(/not calibrated/);
  });

  it("rejects accuracy inside the noise", () => {
    const s = forecastStanding(forecast({ accuracy: 0.51 }));
    expect(s.usable).toBe(false);
    expect(s.why).toMatch(/inside the noise/);
  });

  it("accepts a real edge without overselling it", () => {
    const s = forecastStanding(forecast({}));
    expect(s.usable).toBe(true);
    expect(s.why).toMatch(/long way short of a reason to size up/);
  });

  it("checks calibration before accuracy — the worse objection wins", () => {
    const s = forecastStanding(forecast({ accuracy: 0.9, brier: 0.4 }));
    expect(s.usable).toBe(false);
    expect(s.why).toMatch(/calibrated/);
  });
});

describe("asking the service", () => {
  it("refuses locally rather than round-tripping too little history", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const intel = createIntel();
    return Promise.all([
      intel.regime(bars(50)),
      intel.forecast(bars(50), 24),
    ]).then(([r, f]) => {
      expect(r.ok).toBe(false);
      expect(f.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/at least 200/);
      if (!f.ok) expect(f.error).toMatch(/at least 300/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("turns a dead service into the command that starts it", async () => {
    // "Failed to fetch" is what the browser says for a stopped service, a wrong
    // port and a firewall alike. A dead panel that names the fix is worth far
    // more than one that repeats the browser's word for it.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const r = await createIntel("http://127.0.0.1:8788").regime(bars(400));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("8788");
      expect(r.error).toContain("python run.py");
      expect(r.error).not.toContain("mishel_service");
    }
  });

  it("passes the service's own refusal through verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, err: "scikit-learn/numpy missing" }),
      }),
    );
    const r = await createIntel().regime(bars(400));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("scikit-learn/numpy missing");
  });

  it("reads a regime answer without inventing any part of it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          state: "PANIC/high-vol",
          confidence: 0.81,
          last48: { "TREND-UP": 30, "PANIC/high-vol": 18 },
          n: 400,
          note: "GMM regime (HMM-lite)",
        }),
      }),
    );
    const r = await createIntel().regime(bars(400));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).toBe("PANIC/high-vol");
      expect(r.confidence).toBeCloseTo(0.81, 6);
      expect(r.last48["TREND-UP"]).toBe(30);
    }
  });

  it("falls back to a coin flip rather than NaN on a malformed answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, p_up: "not a number", acc: null, brier: undefined }),
      }),
    );
    const f = await createIntel().forecast(bars(400), 24);
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(f.pUp).toBe(0.5);
      expect(f.accuracy).toBe(0.5);
      expect(f.brier).toBe(0.25);
      // ...and the fallback must then fail the gate, not sail through it.
      expect(forecastStanding(f).usable).toBe(false);
    }
  });

  it("reports an HTTP failure as one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const r = await createIntel().regime(bars(400));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("500");
  });
});
