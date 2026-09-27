import { describe, it, expect } from "vitest";
import {
  COLUMNS,
  OPERATORS,
  parseOperand,
  validateSpec,
  compileSpec,
  conditionText,
  groupText,
  stopText,
  targetText,
  type RuleSpec,
  type Condition,
} from "../src/backtest/rules";
import { SPECS, SPECS_BY_ID } from "../src/backtest/specs";
import { runBacktest, DEFAULT_COSTS, NO_COSTS, type StrategyContext } from "../src/backtest/engine";
import type { BarView } from "../src/chart/series";

/* A deterministic series. Seeded, because a strategy test that fails one run in
   twenty teaches nobody anything. */
/**
 * A spikier series whose MOVE IS IN THE BODY, for the structural rules.
 *
 * Two things `series` cannot produce, and both are needed here. It caps a
 * bar's move at ±1%, so the 1.2% displacement `detectOrderBlocks` looks for is
 * arithmetically impossible; and it sets each open independently of the last
 * close, so the movement lands in the GAPS and every candle body stays tiny.
 * A displacement is a body, so no block could ever form — measured, after the
 * first attempt at this fixture still produced zero.
 *
 * Here each open IS the previous close, which is both more realistic and the
 * smallest change that lets a displacement exist. Nothing in the detector was
 * relaxed to make the rules fire.
 */
function volatile(n: number, seed = 7): BarView[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const shock = rnd() < 0.12 ? 5 : 1;
    px = Math.max(1, px * (1 + (rnd() - 0.5) * 0.02 * shock));
    const c = px;
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.min(o, c) * (1 - rnd() * 0.004);
    bars.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h, l, c, v: 1000 + rnd() * 500 });
  }
  return bars;
}

function series(n: number, seed = 7, drift = 0): BarView[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars: BarView[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px = Math.max(1, px * (1 + drift + (rnd() - 0.5) * 0.02));
    const o = px * (1 + (rnd() - 0.5) * 0.004);
    const c = px;
    const h = Math.max(o, c) * (1 + rnd() * 0.004);
    const l = Math.min(o, c) * (1 - rnd() * 0.004);
    bars.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h, l, c, v: 1000 + rnd() * 500 });
  }
  return bars;
}

function ctxFor(bars: readonly BarView[]): StrategyContext {
  const n = bars.length;
  const col = (pick: (b: BarView) => number): Float64Array => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = pick(bars[i] as BarView);
    return a;
  };
  return {
    bars,
    open: col((b) => b.o),
    high: col((b) => b.h),
    low: col((b) => b.l),
    close: col((b) => b.c),
    volume: col((b) => b.v),
    time: col((b) => b.t),
  };
}

describe("the vocabulary", () => {
  it("reads a column id as a column and a numeric string as a number", () => {
    expect(parseOperand("ema50")).toEqual({ kind: "column", id: "ema50" });
    expect(parseOperand("-80")).toEqual({ kind: "number", value: -80 });
    expect(parseOperand("1.5")).toEqual({ kind: "number", value: 1.5 });
  });

  it("rejects anything that is neither", () => {
    expect(parseOperand("ema51")).toBeNull();
    expect(parseOperand("close()")).toBeNull();
    expect(parseOperand("")).toBeNull();
  });

  it("has a label for every column and operator, so every rule can be printed", () => {
    for (const [id, label] of Object.entries(COLUMNS)) {
      expect(label, id).toBeTruthy();
    }
    for (const [id, label] of Object.entries(OPERATORS)) {
      expect(label, id).toBeTruthy();
    }
  });
});

describe("validation", () => {
  const base: RuleSpec = {
    id: "t",
    name: "T",
    style: "custom",
    long: [["rsi", "crossabove", "30"]],
    stop: { type: "atr", mult: 2 },
    target: { type: "rr", value: 2 },
  };

  it("passes a well-formed spec", () => {
    expect(validateSpec(base)).toEqual([]);
  });

  it("names an unknown indicator rather than letting it evaluate to NaN", () => {
    const bad = { ...base, long: [["ema51", "crossabove", "30"]] as unknown as Condition[] };
    const problems = validateSpec(bad as RuleSpec);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("ema51");
    expect(problems[0]?.where).toBe("long[0]");
  });

  it("names an unknown operator", () => {
    const bad = { ...base, long: [["rsi", "approaches", "30"]] as unknown as Condition[] };
    expect(validateSpec(bad as RuleSpec)[0]?.message).toContain("approaches");
  });

  it("names an unparseable right-hand side", () => {
    const bad = { ...base, long: [["rsi", ">", "oversold"]] as unknown as Condition[] };
    expect(validateSpec(bad as RuleSpec)[0]?.message).toContain("oversold");
  });

  it("rejects a strategy with no entry condition at all", () => {
    const problems = validateSpec({ ...base, long: [] });
    expect(problems.map((p) => p.where)).toContain("entry");
  });

  it("rejects a non-positive stop", () => {
    expect(validateSpec({ ...base, stop: { type: "atr", mult: 0 } })[0]?.where).toBe("stop");
    expect(validateSpec({ ...base, stop: { type: "pct", value: -1 } })[0]?.where).toBe("stop");
  });
});

describe("evaluation", () => {
  const bars = series(400);
  const ctx = ctxFor(bars);

  const compile = (long: Condition[], extra: Partial<RuleSpec> = {}) =>
    compileSpec({
      id: "x",
      name: "X",
      style: "custom",
      long,
      stop: { type: "pct", value: 1 },
      target: { type: "rr", value: 2 },
      ...extra,
    } as RuleSpec);

  it("fires when a state condition holds", () => {
    const s = compile([["close", ">", "0"]]);
    /* Trivially true for every bar past warm-up. */
    expect(s.entry(ctx, 300)).not.toBeNull();
  });

  it("never fires on a condition that cannot hold", () => {
    const s = compile([["close", "<", "0"]]);
    let fired = 0;
    for (let i = s.warmup; i < bars.length; i++) if (s.entry(ctx, i)) fired++;
    expect(fired).toBe(0);
  });

  it("treats an empty group as false, not as 'no filter'", () => {
    /* A spec whose SHORT group is empty must never take a short. This is the
       difference between "no condition" and "no constraint", and reading it the
       permissive way makes every long strategy silently bidirectional. */
    const s = compile([["close", "<", "0"]], { short: [] });
    for (let i = s.warmup; i < bars.length; i++) expect(s.entry(ctx, i)).toBeNull();
  });

  it("makes a NaN condition false rather than zero", () => {
    /* EMA200 is NaN for the first 199 bars. Read as 0, `close > ema200` would
       be true on every one of them and the strategy would open at bar 1. */
    const s = compile([["close", ">", "ema200"]]);
    expect(s.entry(ctx, 5)).toBeNull();
    expect(s.entry(ctx, 50)).toBeNull();
  });

  it("distinguishes a cross from a state", () => {
    const state = compile([["ema9", ">", "ema21"]]);
    const cross = compile([["ema9", "crossabove", "ema21"]]);
    const count = (s: ReturnType<typeof compile>): number => {
      let n = 0;
      for (let i = s.warmup; i < bars.length; i++) if (s.entry(ctx, i)) n++;
      return n;
    };
    /* A cross is an edge; the state is a level. There must be far fewer edges. */
    expect(count(cross)).toBeLessThan(count(state));
    expect(count(cross)).toBeGreaterThan(0);
  });

  it("ANDs the conditions in a group", () => {
    const one = compile([["rsi", ">", "50"]]);
    const two = compile([["rsi", ">", "50"], ["close", ">", "ema50"]]);
    const count = (s: ReturnType<typeof compile>): number => {
      let n = 0;
      for (let i = 210; i < bars.length; i++) if (s.entry(ctx, i)) n++;
      return n;
    };
    expect(count(two)).toBeLessThanOrEqual(count(one));
  });

  it("places the stop below the entry for a long and above it for a short", () => {
    const long = compile([["close", ">", "0"]]);
    const sig = long.entry(ctx, 300);
    expect(sig?.direction).toBe("long");
    expect(sig?.stop).toBeLessThan(bars[300]?.c as number);

    const short = compileSpec({
      id: "s",
      name: "S",
      style: "custom",
      long: [["close", "<", "0"]],
      short: [["close", ">", "0"]],
      stop: { type: "pct", value: 1 },
      target: { type: "rr", value: 2 },
    });
    const ssig = short.entry(ctx, 300);
    expect(ssig?.direction).toBe("short");
    expect(ssig?.stop).toBeGreaterThan(bars[300]?.c as number);
  });

  it("puts the target at the stated R multiple of the stop distance", () => {
    const s = compile([["close", ">", "0"]], { target: { type: "rr", value: 3 } });
    const sig = s.entry(ctx, 300);
    const price = bars[300]?.c as number;
    const risk = price - (sig?.stop as number);
    expect((sig?.target as number) - price).toBeCloseTo(risk * 3, 6);
  });

  it("omits the target entirely when the spec says there is none", () => {
    const s = compile([["close", ">", "0"]], { target: { type: "none" } });
    expect(s.entry(ctx, 300)?.target).toBeUndefined();
  });

  it("applies the exit group for the side that is open, and only that side", () => {
    const s = compileSpec({
      id: "e",
      name: "E",
      style: "custom",
      long: [["close", ">", "0"]],
      exitLong: [["close", ">", "0"]],
      exitShort: [["close", "<", "0"]],
      stop: { type: "pct", value: 1 },
      target: { type: "none" },
    });
    expect(s.exit?.(ctx, { direction: "long" }, 300)).toContain("Exit rule");
    expect(s.exit?.(ctx, { direction: "short" }, 300)).toBeNull();
  });
});

describe("look-ahead", () => {
  /* The property the whole backtest rests on: a decision at bar i must not
     change when bars after i are removed. It is checked here for the compiled
     specs specifically, because a declarative rule that reached forward would
     be far harder to spot by reading than a hand-written one. */
  it("decides identically on a truncated series", () => {
    const bars = series(500, 11);
    const full = ctxFor(bars);

    for (const spec of SPECS) {
      const s = compileSpec(spec);
      for (const i of [260, 320, 400]) {
        const truncated = ctxFor(bars.slice(0, i + 1));
        const a = s.entry(full, i);
        const b = s.entry(truncated, i);
        expect(a === null, `${spec.id} @${i} nullity`).toBe(b === null);
        if (a && b) {
          expect(a.direction, `${spec.id} @${i} direction`).toBe(b.direction);
          expect(a.stop, `${spec.id} @${i} stop`).toBeCloseTo(b.stop, 8);
        }
      }
    }
  });
});

describe("the shipped specs", () => {
  it("all validate", () => {
    for (const s of SPECS) {
      expect(validateSpec(s), s.id).toEqual([]);
    }
  });

  it("have unique ids and names", () => {
    expect(new Set(SPECS.map((s) => s.id)).size).toBe(SPECS.length);
    expect(new Set(SPECS.map((s) => s.name)).size).toBe(SPECS.length);
  });

  it("are indexed by id", () => {
    for (const s of SPECS) expect(SPECS_BY_ID.get(s.id)).toBe(s);
  });

  it("are genuinely distinct — no two produce the same trades", () => {
    /* The failure this guards against is exactly the one in the build these
       were recovered from: several NAMES resolving to one behaviour. If two
       shipped specs ever trade identically, one of them is a costume. */
    const bars = series(600, 3);
    const ctx = ctxFor(bars);
    const fingerprint = (spec: (typeof SPECS)[number]): string => {
      const s = compileSpec(spec);
      const marks: string[] = [];
      for (let i = s.warmup; i < bars.length; i++) {
        const e = s.entry(ctx, i);
        if (e) marks.push(`${i}${e.direction[0]}`);
      }
      return marks.join(",");
    };
    const seen = new Map<string, string>();
    for (const spec of SPECS) {
      const fp = fingerprint(spec);
      if (fp === "") continue; // no signals on this series proves nothing
      const clash = seen.get(fp);
      expect(clash, `${spec.id} trades identically to ${clash}`).toBeUndefined();
      seen.set(fp, spec.id);
    }
  });

  it("each produce at least one signal on some series", () => {
    /* A rule that never fires anywhere is indistinguishable from a broken rule,
       and the vocabulary validator cannot catch a rule that is merely
       impossible. Three seeds and a drifting series between them.
     *
     * The fourth series is v49 and it is a FIXTURE fix rather than a threshold
     * one. `series` moves at most ±1% a bar by construction, and
     * `detectOrderBlocks` needs a 1.2% displacement candle to mark a block —
     * so an order-block rule could not fire on any of the first three, however
     * correct it was. The volatile series is the smallest change that lets a
     * displacement exist at all; nothing in the detector was relaxed to make
     * this pass. */
    for (const spec of SPECS) {
      const s = compileSpec(spec);
      let total = 0;
      for (const [seed, drift, vol] of [
        [3, 0, 1],
        [11, 0.001, 1],
        [29, -0.001, 1],
        [17, 0, 4],
      ] as const) {
        const bars = vol === 1 ? series(700, seed, drift) : volatile(700, seed);
        const ctx = ctxFor(bars);
        for (let i = s.warmup; i < bars.length; i++) if (s.entry(ctx, i)) total++;
      }
      expect(total, `${spec.id} never fired`).toBeGreaterThan(0);
    }
  });

  it("run through the real backtest engine without throwing", () => {
    const bars = series(600, 5);
    for (const spec of SPECS) {
      const r = runBacktest(compileSpec(spec), bars, { costs: DEFAULT_COSTS });
      expect(r, spec.id).toBeTruthy();
      expect(Array.isArray(r.trades), spec.id).toBe(true);
      expect(r.refused, spec.id).toBeNull();
    }
  });

  it("warm up for at least as long as their slowest indicator", () => {
    for (const spec of SPECS) {
      const s = compileSpec(spec);
      const usesEma200 = JSON.stringify(spec).includes("ema200");
      if (usesEma200) expect(s.warmup, spec.id).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("rendering rules as English", () => {
  it("prints a condition with both operands named", () => {
    expect(conditionText(["ema9", "crossabove", "ema21"])).toBe("EMA 9 crosses above EMA 21");
    expect(conditionText(["rsi", "<", "30"])).toBe("RSI(14) is below 30");
  });

  it("makes the AND explicit", () => {
    expect(groupText([["rsi", ">", "50"], ["close", ">", "ema50"]])).toBe(
      "RSI(14) is above 50 AND Close is above EMA 50",
    );
  });

  it("prints an em dash for a group with no conditions rather than an empty string", () => {
    expect(groupText([])).toBe("—");
    expect(groupText(undefined)).toBe("—");
  });

  it("describes stops and targets", () => {
    expect(stopText({ type: "atr", mult: 2 })).toContain("ATR");
    expect(stopText({ type: "pct", value: 1.5 })).toBe("1.5% from entry");
    expect(targetText({ type: "rr", value: 2 })).toBe("2× the risk");
    expect(targetText({ type: "none" })).toBe("exit rule only");
  });

  it("carries the spec note into the compiled rule documentation", () => {
    const withNote = SPECS.find((s) => s.note !== undefined);
    expect(withNote).toBeDefined();
    const compiled = compileSpec(withNote as RuleSpec);
    expect(compiled.rules.note).toBe(withNote?.note);
  });
});

describe("costs still apply to declarative strategies", () => {
  it("a costed run never beats a free one", () => {
    const bars = series(600, 17);
    const spec = SPECS_BY_ID.get("ema-9-21-cross") as RuleSpec;
    const free = runBacktest(compileSpec(spec), bars, { costs: NO_COSTS });
    const costed = runBacktest(compileSpec(spec), bars, { costs: DEFAULT_COSTS });
    expect(free.trades.length).toBeGreaterThan(0);
    /* Same signals, same count — costs change the fills, not the decisions. */
    expect(costed.trades.length).toBe(free.trades.length);
    const last = (r: typeof free): number => (r.equity[r.equity.length - 1] as number);
    expect(last(costed)).toBeLessThanOrEqual(last(free) + 1e-12);
  });
});
