/**
 * ONE OWNER FOR HOW A BACKTEST WAS CONFIGURED.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The engine's knobs are spread across five places: `BacktestOptions` holds
 * nine, `StudyOptions` extends it, `promote.ts` keeps the promotion gate as
 * three module constants, `DEFAULT_COSTS` is a fourth, and the walk-forward
 * window shape is argument-by-argument at each call site. CLAUDE.md already
 * records what that costs — eight places charged `DEFAULT_COSTS`, four of them
 * deciding something, and the count had to be replaced by a list because it
 * was wrong every time it was quoted.
 *
 * Nothing could present those knobs to the operator, because there was no
 * object to present. This is that object, and the whole point of the first
 * test is that it changes NOTHING: the standard settings must project onto
 * exactly the values the engine uses today, or every backtest in the product
 * has been silently re-priced by a refactor.
 *
 * It deliberately does NOT change the engine's signatures. A settings object
 * that produced the existing option types is a reversible addition; rewriting
 * nine call sites to take a new shape is not.
 */

import { describe, expect, it } from "vitest";
import {
  PRESETS,
  STANDARD,
  changesFrom,
  flatteryIn,
  presetById,
  toBacktestOptions,
  type RunSettings,
} from "../src/backtest/settings";
import { DEFAULT_COSTS } from "../src/backtest/engine";
import { MAX_PBO, MIN_OOS_TRADES, MIN_RETENTION, STANDARD_BAR } from "../src/backtest/promote";
import { barOf } from "../src/backtest/settings";
import { buildSettings, type DefDeps } from "../src/settings/defs";
import { stubDeps } from "./helpers/shippedsettings";
import { createSettingsStore } from "../src/backtest/settingsstore";
import { createKV, memoryRawStore } from "../src/store/kv";

describe("the standard settings change nothing", () => {
  it("PROJECTS ONTO EXACTLY WHAT THE ENGINE ALREADY DOES", () => {
    /* The test this file exists for. Every number here is the engine's own
       fallback, read from the engine rather than retyped: `costs ?? DEFAULT_COSTS`,
       `riskPerTrade ?? 0.01`, `minCoverage ?? 0.98`. If this fails, a refactor
       has re-priced every backtest in the product and the board's verdicts
       moved for a reason nobody chose. */
    const o = toBacktestOptions(STANDARD);
    expect(o.costs).toEqual(DEFAULT_COSTS);
    expect(o.riskPerTrade).toBe(0.01);
    expect(o.minCoverage).toBe(0.98);
    expect(o.allowDemo).toBe(false);
  });

  it("TAKES THE PROMOTION GATE FROM THE GATE, not a second copy of it", () => {
    /* Three hand-written types of one value have caused three defects here
       already. The gate's thresholds are imported, so a change to `promote.ts`
       cannot leave this disagreeing with it. */
    expect(STANDARD.bar.minTrades).toBe(MIN_OOS_TRADES);
    expect(STANDARD.bar.maxPbo).toBe(MAX_PBO);
    expect(STANDARD.bar.minRetention).toBe(MIN_RETENTION);
  });

  it("IS HONEST, with nothing to declare", () => {
    expect(flatteryIn(STANDARD)).toEqual([]);
  });
});

describe("a cost model is a choice, and the choice is recorded", () => {
  it("CHARGES THE MEASURED SPREAD ONLY WHEN ONE IS SUPPLIED", () => {
    /* An assumed cost is an assumed conclusion, and the measured figure must
       not silently replace the assumption — a number that moves under the
       operator because a service answered is worse than a disagreement they
       can see. So "measured" with nothing measured falls back and SAYS SO. */
    const measured: RunSettings = { ...STANDARD, costs: { model: "measured" } };
    expect(toBacktestOptions(measured).costs).toEqual(DEFAULT_COSTS);
    expect(flatteryIn(measured)).toEqual([]);

    const withBroker = toBacktestOptions(measured, { spread: 0.000042 });
    expect(withBroker.costs?.spread).toBe(0.000042);
    /* Everything it was not told stays the standard assumption. */
    expect(withBroker.costs?.commission).toBe(DEFAULT_COSTS.commission);
  });

  it("CHARGES NOTHING ONLY WHEN ASKED, and calls that flattery", () => {
    const free: RunSettings = { ...STANDARD, costs: { model: "none" } };
    const o = toBacktestOptions(free);
    expect(o.costs).toEqual({ spread: 0, commission: 0, slippage: 0, carryPerNight: 0 });
    /* PINS THE FACT, NOT A WORD. The first version asked for /cost/i and the
       sentence names the three things instead — "No spread, commission or
       financing is charged" — which is better copy and a correct message. A
       test that pins a sentence should pin the fact in it. */
    expect(flatteryIn(free).join(" ")).toMatch(/spread|commission|financing/i);
    expect(flatteryIn(free).join(" ")).toMatch(/never tradeable/i);
  });

  it("CAN CHARGE MORE THAN REAL, which is not the safe direction", () => {
    /* Overcharging does not make a result safer: it DISCARDS rules that would
       have cleared the real spread, silently. It is offered, and it is named. */
    const worst = toBacktestOptions({ ...STANDARD, costs: { model: "worst" } });
    expect((worst.costs as { spread: number }).spread).toBeGreaterThan(DEFAULT_COSTS.spread);
  });
});

describe("what a configuration admits about itself", () => {
  it("NAMES ENTERING AT THE SIGNAL'S CLOSE AS LOOK-AHEAD", () => {
    /* The defect this product already fixed once: filling at the close of the
       bar that produced the signal is a price that did not exist yet. It stays
       available so the operator can see what it inflates by, and it is never
       quiet about it. */
    const peek: RunSettings = { ...STANDARD, fills: { ...STANDARD.fills, entry: "signal-close" } };
    expect(flatteryIn(peek).join(" ")).toMatch(/look-ahead|did not exist/i);
  });

  it("NAMES TURNING THE SEARCH CHARGE OFF", () => {
    const loose: RunSettings = { ...STANDARD, bar: { ...STANDARD.bar, chargeForSearch: false } };
    expect(flatteryIn(loose).join(" ")).toMatch(/search/i);
  });

  it("COLLECTS EVERY ADMISSION, not just the first", () => {
    const worst: RunSettings = {
      ...STANDARD,
      fills: { ...STANDARD.fills, entry: "signal-close" },
      costs: { model: "none" },
      bar: { ...STANDARD.bar, chargeForSearch: false },
    };
    expect(flatteryIn(worst)).toHaveLength(3);
  });
});

describe("presets", () => {
  it("SHIP A STANDARD THAT IS THE STANDARD", () => {
    expect(presetById("standard")?.settings).toEqual(STANDARD);
  });

  it("GIVE EVERY PRESET A NAME, A NOTE AND AN HONESTY FLAG", () => {
    expect(PRESETS.length).toBeGreaterThan(3);
    for (const p of PRESETS) {
      expect(p.name.length, `${p.id} has no name`).toBeGreaterThan(2);
      expect(p.note.length, `${p.id} does not say what it is for`).toBeGreaterThan(10);
      /* The flag is DERIVED, never declared: a preset cannot claim to be
         honest while setting something that flatters. */
      expect(p.honest, `${p.id} disagrees with its own settings`).toBe(flatteryIn(p.settings).length === 0);
    }
  });

  it("INCLUDE ONE THAT IS DELIBERATELY DISHONEST, and know it", () => {
    /* Worth having on purpose: the fastest way to learn what the checks are
       protecting you from is to switch them off and watch every number
       improve. It is the one preset that must never be the default. */
    const lie = PRESETS.filter((p) => !p.honest);
    expect(lie.length).toBeGreaterThan(0);
    for (const p of lie) expect(p.id).not.toBe("standard");
  });

  it("REFUSE AN ID THEY DO NOT HAVE, rather than guessing", () => {
    expect(presetById("whatever-this-is")).toBeUndefined();
  });
});

describe("what changed, so two runs can be told apart", () => {
  it("SAYS NOTHING CHANGED WHEN NOTHING DID", () => {
    expect(changesFrom(STANDARD, STANDARD)).toEqual([]);
  });

  it("NAMES THE FIELD, THE OLD VALUE AND THE NEW ONE", () => {
    const edited: RunSettings = { ...STANDARD, bar: { ...STANDARD.bar, minTrades: 120 } };
    const diff = changesFrom(STANDARD, edited);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.label).toMatch(/trades/i);
    expect(diff[0]?.from).toBe(String(MIN_OOS_TRADES));
    expect(diff[0]?.to).toBe("120");
  });

  it("FINDS A CHANGE IN EVERY GROUP, so no knob is invisible to it", () => {
    /* A diff that silently misses a group is how a result ends up described by
       the wrong settings — and the whole reason for recording settings is to
       tell two runs apart. */
    const edited: RunSettings = {
      fills: { entry: "signal-close", slippage: 0.001, settleFromMinutes: false },
      costs: { model: "none" },
      bar: { minTrades: 10, maxPbo: 0.9, minRetention: 0.1, chargeForSearch: false },
      risk: { perTrade: 0.05 },
      data: { minCoverage: 0.1, allowDemo: true },
      windows: { count: 3, trainBars: 1000, testBars: 200, purgeBars: 0 },
    };
    const groups = new Set(changesFrom(STANDARD, edited).map((c) => c.group));
    expect(groups).toEqual(new Set(["fills", "costs", "bar", "risk", "data", "windows"]));
  });
});

describe("the Backtesting section in Settings", () => {
  const built = (over: Partial<DefDeps> = {}) => buildSettings(stubDeps(over));
  const find = (id: string) => built().find((x) => x.id === id);

  it("NEVER SHOWS A VALUE THE PRESET CONTROL DOES NOT OFFER", () => {
    /* A `<select>` handed a value outside its options shows the FIRST one and
       says nothing. `presetId()` answers null the moment a knob is touched, so
       without an explicit "Edited" option this control would read "Standard"
       over settings that are nothing of the kind — the defect this repository
       records on a bar-size picker showing 5m while the plan refused on 3m. */
    const store = createSettingsStore(createKV(memoryRawStore()));
    const defs = buildSettings(stubDeps({ backtest: store }));
    const preset = defs.find((x) => x.id === "backtest.preset");
    expect(preset, "the Backtesting section is not being built").toBeDefined();

    const offered = new Set(
      preset?.control.kind === "select" ? preset.control.options.map((o) => o.value) : [],
    );
    expect(offered.has(preset?.read() ?? ""), "it opens on a value it does not offer").toBe(true);

    store.patch("bar", { minTrades: 999 });
    expect(offered.has(preset?.read() ?? ""), "an edited configuration reads as a value it does not offer").toBe(true);
    expect(preset?.read()).not.toBe("standard");
  });

  it("DOES NOTHING WHEN 'EDITED' IS CHOSEN, rather than silently resetting", () => {
    const store = createSettingsStore(createKV(memoryRawStore()));
    const defs = buildSettings(stubDeps({ backtest: store }));
    const preset = defs.find((x) => x.id === "backtest.preset");
    store.patch("bar", { minTrades: 999 });
    preset?.write?.(preset.read());
    expect(store.settings().bar.minTrades, "choosing Edited reset the settings").toBe(999);
  });

  it("MOVES EVERY KNOB IT OFFERS", () => {
    /* Each knob reads and writes the ONE store the shell owns, so a control
       that appears to work and writes a copy would pass nothing here. */
    const store = createSettingsStore(createKV(memoryRawStore()));
    const defs = buildSettings(stubDeps({ backtest: store }));
    const knobs = defs.filter((x) => x.id.startsWith("backtest.") && x.control.kind !== "note" && x.id !== "backtest.preset");
    expect(knobs.length, "no backtester knobs reached Settings").toBeGreaterThan(5);

    for (const k of knobs) {
      const before = k.read();
      const next =
        k.control.kind === "toggle" ? String(before !== "true")
        : k.control.kind === "select" ? (k.control.options.find((o) => o.value !== before)?.value ?? before)
        : String(Number(before) + 1);
      k.write?.(next);
      /* COMPARED AS A VALUE, NOT AS A STRING. A number control is free to read
         back formatted — the risk knob answers "2.00" for 2 — and asserting on
         the spelling would fail a control that works. What must hold is that
         the value MOVED and now means what was written. */
      const got = k.read();
      expect(got, `${k.id} did not change after being written`).not.toBe(before);
      if (k.control.kind === "number") expect(Number(got), k.id).toBe(Number(next));
      else expect(got, k.id).toBe(next);
    }
  });

  it("SAYS WHAT THE SETTINGS ADMIT, and says nothing when there is nothing", () => {
    const store = createSettingsStore(createKV(memoryRawStore()));
    const defs = buildSettings(stubDeps({ backtest: store }));
    const note = defs.find((x) => x.id === "backtest.flattery");
    expect(note?.read()).toMatch(/stand on their own/i);
    store.usePreset("lie");
    expect(note?.read()).toMatch(/look-ahead|did not exist/i);
  });

  it("IS ABSENT, NOT BROKEN, WHEN THE STORE IS NOT WIRED", () => {
    /* Optional on `DefDeps`, like every other wiring here: a build that has
       not passed it still compiles and says why rather than reading zeros. */
    const defs = built({ backtest: undefined });
    expect(defs.filter((x) => x.id.startsWith("backtest.") && x.control.kind === "number")).toEqual([]);
    expect(defs.find((x) => x.id === "backtest.preset")?.unavailable?.()).toBeTruthy();
  });
});

describe("the bar the gate is handed", () => {
  it("IS THE GATE'S OWN PUBLISHED STANDARD, for the standard settings", () => {
    /* A projection that quietly differed from the gate's own default would
       re-decide every strategy on the shelf for a reason nobody chose — the
       same guarantee `toBacktestOptions(STANDARD)` carries for the costs. */
    expect(barOf(STANDARD)).toEqual(STANDARD_BAR);
  });

  it("CARRIES AN EDITED BAR THROUGH", () => {
    const edited: RunSettings = { ...STANDARD, bar: { ...STANDARD.bar, minTrades: 7, maxPbo: 0.8 } };
    expect(barOf(edited)).toEqual({ minTrades: 7, maxPbo: 0.8, minRetention: STANDARD.bar.minRetention });
  });

  it("LEAVES THE SEARCH CHARGE OUT, because it is a different question", () => {
    /* `chargeForSearch` belongs to the best-of-N hurdle, not the promotion
       gate: one asks whether the winner beat what luck scores over the field,
       the other whether this strategy held up out of sample at all. One object
       holding both would invite switching off the wrong one. */
    const off: RunSettings = { ...STANDARD, bar: { ...STANDARD.bar, chargeForSearch: false } };
    expect(barOf(off)).toEqual(barOf(STANDARD));
    expect(Object.keys(barOf(STANDARD)).sort()).toEqual(["maxPbo", "minRetention", "minTrades"]);
  });
});
