import { describe, it, expect } from "vitest";
import { confluence, toScanBars, MIN_BARS, type ScanBars } from "../src/scan/confluence";

/** Build a synthetic series with a controllable shape. */
function series(
  n: number,
  priceAt: (i: number) => number,
  volAt: (i: number) => number = () => 1000,
): ScanBars {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = priceAt(i);
    const o = i === 0 ? c : priceAt(i - 1);
    bars.push({
      t: i * 3_600_000,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: volAt(i),
    });
  }
  return toScanBars(bars);
}

describe("insufficient data", () => {
  it("returns neutral with a reason rather than a score", () => {
    // A confident-looking number computed from 30 bars is worse than an honest
    // refusal to produce one.
    const r = confluence(series(30, (i) => 100 + i));
    expect(r.bias).toBe("neutral");
    expect(r.score).toBe(0);
    expect(r.insufficient).toMatch(/need 210/);
    expect(r.signals).toEqual([]);
  });

  it("produces a real read once there is enough history", () => {
    const r = confluence(series(MIN_BARS + 20, (i) => 100 + i));
    expect(r.insufficient).toBeNull();
    expect(r.signals.length).toBeGreaterThan(3);
  });

  it("refuses a series whose last close is unusable", () => {
    const s = series(300, (i) => 100 + i);
    s.c[s.c.length - 1] = NaN;
    expect(confluence(s).insufficient).toMatch(/usable price/);
  });
});

describe("directional read", () => {
  it("reads a clean uptrend as long", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.5));
    expect(r.bias).toBe("long");
    expect(r.score).toBeGreaterThan(0.2);
  });

  it("reads a clean downtrend as short", () => {
    const r = confluence(series(400, (i) => 400 - i * 0.5));
    expect(r.bias).toBe("short");
    expect(r.score).toBeLessThan(-0.2);
  });

  it("reads a flat market as neutral", () => {
    const r = confluence(series(400, () => 100));
    expect(r.bias).toBe("neutral");
    expect(Math.abs(r.score)).toBeLessThan(0.12);
  });

  it("does not claim trend STRUCTURE in a choppy range", () => {
    // Momentum in a chop is real: at the top of a swing RSI and MACD genuinely
    // read up, and suppressing that would be throwing away information. What
    // must NOT happen is the engine claiming structure that is not there.
    const chop = confluence(series(400, (i) => 100 + Math.sin(i / 3) * 2));
    expect(chop.signals.find((s) => s.id === "ma-stack")?.direction).toBe("neutral");
    expect(chop.signals.find((s) => s.id === "ma-stack")?.reason).toMatch(/no clean trend/);
  });

  it("ranks a chop below a clean trend of the same direction", () => {
    // The screener consequence of the above: without a structure gate, chop
    // sorts alongside a real trend and sends you into it.
    const chop = confluence(series(400, (i) => 100 + Math.sin(i / 3) * 2));
    const trend = confluence(series(400, (i) => 100 + i * 0.5));
    if (chop.bias !== "neutral") {
      expect(chop.confidence).toBeLessThan(trend.confidence);
    }
  });

  it("keeps the score inside -1..1", () => {
    for (const f of [
      (i: number) => 100 + i * 5,
      (i: number) => 5000 - i * 12,
      (i: number) => 100 + Math.sin(i / 7) * 30,
    ]) {
      const r = confluence(series(400, f));
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("the glass-box contract", () => {
  it("gives every signal a non-empty plain-language reason", () => {
    // The rule the whole module exists to enforce: no number without its reason.
    const r = confluence(series(400, (i) => 100 + i * 0.4));
    expect(r.signals.length).toBeGreaterThan(0);
    for (const s of r.signals) {
      expect(s.reason.trim().length).toBeGreaterThan(10);
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(s.id.trim().length).toBeGreaterThan(0);
    }
  });

  it("emits reasons even for modules that read neutral", () => {
    // A module that abstains must still say why, or the read looks incomplete
    // rather than deliberately undecided.
    const r = confluence(series(400, () => 100));
    const neutral = r.signals.filter((s) => s.direction === "neutral");
    expect(neutral.length).toBeGreaterThan(0);
    for (const s of neutral) expect(s.reason.trim().length).toBeGreaterThan(10);
  });

  it("keeps signal ids unique so the UI can key on them", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.4));
    const ids = r.signals.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every strength within 0..1", () => {
    const r = confluence(series(400, (i) => 100 + i * 9));
    for (const s of r.signals) {
      expect(s.strength).toBeGreaterThanOrEqual(0);
      expect(s.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe("volatility gates confidence, never direction", () => {
  it("does not let the volatility module vote", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.4));
    const vol = r.signals.find((s) => s.id === "volatility");
    expect(vol).toBeDefined();
    expect(vol?.direction).toBe("neutral");
    expect(vol?.weight).toBe(0);
  });

  it("lowers confidence when volatility spikes, keeping the same bias", () => {
    // A market can be violently trending or quietly trending. Volatility says
    // how much to trust the read, not which way to lean.
    const calm = confluence(series(400, (i) => 100 + i * 0.4));

    // Same trend, but the last few bars explode in range.
    const bars = [];
    for (let i = 0; i < 400; i++) {
      const c = 100 + i * 0.4;
      const o = i === 0 ? c : 100 + (i - 1) * 0.4;
      const wild = i > 394 ? 0.25 : 0.001;
      bars.push({
        t: i * 3_600_000,
        o,
        h: Math.max(o, c) * (1 + wild),
        l: Math.min(o, c) * (1 - wild),
        c,
        v: 1000,
      });
    }
    const wildRead = confluence(toScanBars(bars));

    expect(wildRead.bias).toBe(calm.bias);
    expect(wildRead.confidence).toBeLessThan(calm.confidence);
    expect(wildRead.signals.find((s) => s.id === "volatility")?.reason).toMatch(/less reliable/);
  });
});

describe("agreement", () => {
  it("is reported separately from score", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.5));
    expect(r.agreement).toBeGreaterThan(0);
    expect(r.agreement).toBeLessThanOrEqual(1);
  });

  it("is high when the modules are unanimous", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.5));
    expect(r.agreement).toBeGreaterThan(0.8);
  });

  it("stays within 0..1 on a conflicted series", () => {
    // A late reversal puts short-term and long-term modules on opposite sides.
    const r = confluence(series(400, (i) => (i < 340 ? 100 + i * 0.5 : 270 - (i - 340) * 1.5)));
    expect(r.agreement).toBeGreaterThanOrEqual(0);
    expect(r.agreement).toBeLessThanOrEqual(1);
  });
});

describe("volume confirmation", () => {
  it("only confirms the direction the bar already went", () => {
    // Heavy volume on a DOWN bar is not bullish because volume is "strong".
    const bars = [];
    for (let i = 0; i < 400; i++) {
      const down = i === 399;
      const o = 100;
      const c = down ? 95 : 100;
      bars.push({
        t: i * 3_600_000,
        o,
        h: 101,
        l: 94,
        c,
        v: down ? 10_000 : 1000,
      });
    }
    const r = confluence(toScanBars(bars));
    const vol = r.signals.find((s) => s.id === "volume");
    expect(vol?.direction).toBe("short");
    expect(vol?.reason).toMatch(/confirming a short bar/);
  });

  it("abstains when volume is unremarkable", () => {
    const r = confluence(series(400, (i) => 100 + i * 0.2));
    const vol = r.signals.find((s) => s.id === "volume");
    expect(vol?.direction).toBe("neutral");
    expect(vol?.reason).toMatch(/unremarkable/);
  });
});

describe("determinism", () => {
  it("gives identical results for identical input", () => {
    const a = confluence(series(400, (i) => 100 + Math.sin(i / 9) * 8 + i * 0.1));
    const b = confluence(series(400, (i) => 100 + Math.sin(i / 9) * 8 + i * 0.1));
    expect(a).toEqual(b);
  });
});
