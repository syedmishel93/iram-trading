/**
 * Indicator parameters.
 *
 * The panel that owns these used to refuse to show them at all, on the grounds
 * that spinners invite tuning an indicator until it agrees with you. The
 * feature is now there, so the tests are about the part of that concern which
 * survives: a tuned indicator must be knowable AS tuned, from its parameters
 * alone, without anybody having to remember.
 *
 * The rest is the persistence contract every stored preference in this app
 * follows — clamp, never reject; drop what you do not recognise; never brick
 * on the settings of an older build.
 */

import { describe, expect, it } from "vitest";
import {
  PARAMS,
  clampParam,
  defaults,
  hasParams,
  isDefault,
  param,
  paramDefs,
  paramLabel,
  sanitiseAll,
  sanitiseParams,
  tuned,
  tunedCount,
  type ParamDef,
} from "../src/chart/params";
import { PANES, runPanes } from "../src/chart/panes";
import { STUDIES } from "../src/chart/studies";

const colour = (_t: string, fallback: string): string => fallback;

const seriesOf = (n: number): { h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array } => {
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = 100 + Math.sin(i / 7) * 5;
    c[i] = p;
    h[i] = p + 1;
    l[i] = p - 1;
    v[i] = 1000 + i;
  }
  return { h, l, c, v };
};

describe("the registry", () => {
  it("only names indicators that exist", () => {
    const known = new Set([...STUDIES.map((s) => s.id), ...PANES.map((p) => p.id)]);
    for (const id of Object.keys(PARAMS)) expect(known.has(id), id).toBe(true);
  });

  /* A default outside its own range would be unreachable through the control
     that edits it — you could never get back to it. */
  it("keeps every published default inside its own range", () => {
    for (const [id, defs] of Object.entries(PARAMS)) {
      for (const d of defs) {
        expect(d.def, `${id}.${d.id}`).toBeGreaterThanOrEqual(d.min);
        expect(d.def, `${id}.${d.id}`).toBeLessThanOrEqual(d.max);
      }
    }
  });

  it("gives every parameter a unique id within its indicator", () => {
    for (const [id, defs] of Object.entries(PARAMS)) {
      expect(new Set(defs.map((d) => d.id)).size, id).toBe(defs.length);
    }
  });

  it("declares integer periods as integers", () => {
    for (const [id, defs] of Object.entries(PARAMS)) {
      for (const d of defs.filter((x) => x.kind === "int")) {
        expect(Number.isInteger(d.def), `${id}.${d.id}`).toBe(true);
      }
    }
  });
});

describe("clampParam", () => {
  const int: ParamDef = { id: "p", label: "P", kind: "int", def: 14, min: 2, max: 400, step: 1 };
  const flt: ParamDef = { id: "m", label: "M", kind: "float", def: 2, min: 0.1, max: 10, step: 0.1 };

  it("pulls an out-of-range value to the nearest legal one rather than refusing", () => {
    expect(clampParam(int, 999)).toBe(400);
    expect(clampParam(int, -5)).toBe(2);
  });

  /**
   * `rsi(close, 14.5)` does not throw — it returns a series that is subtly not
   * an RSI. A period that indexes an array has to be an integer before it gets
   * near the arithmetic.
   */
  it("rounds an integer parameter", () => {
    expect(clampParam(int, 14.5)).toBe(15);
    expect(clampParam(int, 20.4)).toBe(20);
  });

  it("leaves a float alone", () => {
    expect(clampParam(flt, 2.5)).toBe(2.5);
  });

  it("falls back to the published default for anything that is not a number", () => {
    expect(clampParam(int, "banana")).toBe(14);
    expect(clampParam(int, null)).toBe(14);
    expect(clampParam(int, undefined)).toBe(14);
    expect(clampParam(int, NaN)).toBe(14);
    /* Infinity is junk, not "as large as you can go" — it comes from a divide
       somewhere upstream, and clamping it to the maximum would launder a bug
       into a plausible 400-period indicator. */
    expect(clampParam(int, Infinity)).toBe(14);
    /* The three that read as 0 through `Number()` and used to clamp to the
       MINIMUM, silently turning a 14-period RSI into a 2-period one. */
    expect(clampParam(int, "")).toBe(14);
    expect(clampParam(int, [])).toBe(14);
    expect(clampParam(int, {})).toBe(14);
  });

  /* Number-typed inputs hand back strings. */
  it("accepts the string a number input actually produces", () => {
    expect(clampParam(int, "21")).toBe(21);
  });
});

describe("sanitiseParams", () => {
  it("fills every missing parameter with its published default", () => {
    expect(sanitiseParams("macd", {})).toEqual({ fast: 12, slow: 26, signal: 9 });
  });

  /**
   * These are persisted. A build that renames or drops a parameter must not
   * brick the panel for someone who saved a value under the old name — the
   * same rule `sanitiseOpen` and `runStudies` follow.
   */
  it("drops a parameter it does not recognise", () => {
    expect(sanitiseParams("rsi", { period: 9, fromTheFuture: 3 })).toEqual({ period: 9 });
  });

  it("clamps what it keeps", () => {
    expect(sanitiseParams("rsi", { period: 100_000 })).toEqual({ period: 400 });
  });

  it("returns nothing for an indicator with nothing to tune", () => {
    expect(sanitiseParams("vwap", { period: 9 })).toEqual({});
    expect(hasParams("vwap")).toBe(false);
  });

  it("survives junk where an object was expected", () => {
    expect(sanitiseParams("rsi", null)).toEqual({ period: 14 });
    expect(sanitiseParams("rsi", "nonsense")).toEqual({ period: 14 });
  });
});

describe("sanitiseAll", () => {
  /**
   * An indicator on its published settings is stored as ABSENT, not as a map
   * of defaults. It keeps the preferences blob small and makes "is anything
   * tuned" a question about the map's keys.
   */
  it("stores only what is actually tuned", () => {
    const out = sanitiseAll({ rsi: { period: 14 }, macd: { fast: 5, slow: 26, signal: 9 } });
    expect(out).not.toHaveProperty("rsi");
    expect(out["macd"]).toEqual({ fast: 5, slow: 26, signal: 9 });
  });

  it("ignores an indicator that has no parameters", () => {
    expect(sanitiseAll({ vwap: { period: 3 } })).toEqual({});
  });

  it("survives junk", () => {
    expect(sanitiseAll(null)).toEqual({});
    expect(sanitiseAll(42)).toEqual({});
  });
});

describe("knowing when something is tuned", () => {
  it("treats absent settings as the published definition", () => {
    expect(isDefault("rsi", undefined)).toBe(true);
    expect(tuned("rsi", undefined)).toEqual([]);
  });

  it("spots a single changed number among several", () => {
    const p = { fast: 12, slow: 30, signal: 9 };
    expect(isDefault("macd", p)).toBe(false);
    expect(tuned("macd", p)).toEqual(["Slow"]);
  });

  /* A saved value outside the range compares against its CLAMPED self, or an
     indicator that is really running the default would report as tuned. */
  it("compares against the value that will actually be used", () => {
    expect(isDefault("rsi", { period: 14.4 })).toBe(true);
  });

  it("counts tuned indicators across the whole map", () => {
    expect(tunedCount({ rsi: { period: 7 }, adx: { period: 14 } })).toBe(1);
    expect(tunedCount({})).toBe(0);
  });
});

describe("paramLabel", () => {
  it("prints the published values when nothing is set", () => {
    expect(paramLabel("macd", undefined)).toBe("12, 26, 9");
    expect(paramLabel("rsi", undefined)).toBe("14");
  });

  it("prints what is actually running", () => {
    expect(paramLabel("rsi", { period: 7 })).toBe("7");
  });

  it("does not print a float as a long binary tail", () => {
    expect(paramLabel("bollinger", { period: 20, mult: 2.1 })).toBe("20, 2.1");
  });

  it("is empty for an indicator with no parameters", () => {
    expect(paramLabel("vwap", undefined)).toBe("");
  });
});

describe("param", () => {
  it("reads the published default when nothing is saved", () => {
    expect(param("rsi", undefined, "period")).toBe(14);
  });

  it("clamps on the way out, so no indicator ever receives an illegal value", () => {
    expect(param("rsi", { period: -3 }, "period")).toBe(2);
  });

  it("returns NaN for a parameter the indicator does not have, rather than a plausible number", () => {
    expect(param("rsi", { period: 9 }, "mult")).toBeNaN();
  });
});

describe("defaults", () => {
  it("agrees with the registry", () => {
    for (const id of Object.keys(PARAMS)) {
      const d = defaults(id);
      for (const def of paramDefs(id)) expect(d[def.id], `${id}.${def.id}`).toBe(def.def);
    }
  });
});

/**
 * The end of the chain: a changed period has to reach the arithmetic AND the
 * label. A pane that computes on 7 and still says "RSI 14" is the exact
 * forgetting the old no-spinners rule was worried about.
 */
describe("parameters reach the pane", () => {
  const input = { ...seriesOf(300), colour };

  it("labels the pane with the settings it actually ran", () => {
    const [standard] = runPanes(["rsi"], input);
    const [tunedPane] = runPanes(["rsi"], input, { rsi: { period: 7 } });
    expect(standard?.label).toBe("RSI 14");
    expect(tunedPane?.label).toBe("RSI 7");
  });

  it("changes the values, not just the label", () => {
    const [standard] = runPanes(["rsi"], input);
    const [tunedPane] = runPanes(["rsi"], input, { rsi: { period: 7 } });
    const a = standard?.series[0]?.values as Float64Array;
    const b = tunedPane?.series[0]?.values as Float64Array;
    expect(a.length).toBe(b.length);
    expect(a[a.length - 1]).not.toBeCloseTo(b[b.length - 1] as number, 6);
  });

  it("uses slashes for the multi-parameter panes, as every terminal does", () => {
    const [macd] = runPanes(["macd"], input, { macd: { fast: 5, slow: 20, signal: 4 } });
    expect(macd?.label).toBe("MACD 5/20/4");
  });

  it("falls back to the published definition when the map has no entry", () => {
    const [rsi] = runPanes(["rsi"], input, { macd: { fast: 5, slow: 20, signal: 4 } });
    expect(rsi?.label).toBe("RSI 14");
  });

  /* An illegal persisted value must not reach the indicator. */
  it("clamps a stored value the pane would otherwise choke on", () => {
    const [rsi] = runPanes(["rsi"], input, { rsi: { period: -8 } });
    expect(rsi?.label).toBe("RSI 2");
  });
});
